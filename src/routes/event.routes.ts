import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { query } from '../config/db';
import { env } from '../config/env';
import { redis, invalidateEventsCache } from '../config/redis';
import { authenticate, authorize } from '../middleware/auth';
import { enqueueEventUpdatedFanout } from '../queues/notification.queue';
import { sendEventUpdateEmail } from '../services/email.service';

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
});

const createEventSchema = z.object({
  title: z.string().trim().min(3, 'Title must be at least 3 characters').max(200),
  description: z.string().trim().min(5, 'Description must be at least 5 characters'),
  venue: z.string().trim().min(3, 'Venue must be at least 3 characters').max(255),
  event_date: z.string().refine((val) => !isNaN(Date.parse(val)), {
    message: 'Invalid event_date format (must be ISO string or valid date string)',
  }),
  total_tickets: z.number().int().positive('Total tickets must be greater than 0'),
  price_cents: z.number().int().nonnegative('Price must be greater than or equal to 0'),
});

const updateEventSchema = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  description: z.string().trim().min(5).optional(),
  venue: z.string().trim().min(3).max(255).optional(),
  event_date: z.string().refine((val) => !isNaN(Date.parse(val)), {
    message: 'Invalid event_date format',
  }).optional(),
  total_tickets: z.number().int().positive().optional(),
  price_cents: z.number().int().nonnegative().optional(),
  update_summary: z.string().optional(),
});

export interface EventRow {
  id: string;
  organizer_id: string;
  title: string;
  description: string;
  venue: string;
  event_date: string;
  total_tickets: number;
  available_tickets: number;
  price_cents: number;
  created_at: string;
  updated_at: string;
}

export async function eventRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/events (Public)
  fastify.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = listQuerySchema.safeParse(request.query);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Invalid query parameters',
        details: parseResult.error.flatten().fieldErrors,
      });
    }

    const { page, limit, search } = parseResult.data;
    const offset = (page - 1) * limit;
    const cacheKey = `events:list:page:${page}:limit:${limit}:search:${search || ''}`;

    // Redis Cache-Aside for Optimized Mode
    if (env.APP_MODE === 'optimized') {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          reply.header('x-cache', 'HIT');
          return reply.send(JSON.parse(cached));
        }
      } catch (cacheErr) {
        console.error('[Cache] Redis error reading list cache:', cacheErr);
      }
    }

    let countSql = 'SELECT COUNT(*)::int as count FROM events';
    let dataSql = 'SELECT * FROM events';
    const params: unknown[] = [];

    if (search && search.trim().length > 0) {
      const searchTerm = `%${search.trim()}%`;
      countSql += ' WHERE (title ILIKE $1 OR venue ILIKE $1)';
      dataSql += ' WHERE (title ILIKE $1 OR venue ILIKE $1)';
      params.push(searchTerm);
    }

    dataSql += ` ORDER BY event_date ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

    const [countRes, dataRes] = await Promise.all([
      query<{ count: number }>(countSql, params),
      query<EventRow>(dataSql, [...params, limit, offset]),
    ]);

    const total = countRes.rows[0]?.count || 0;
    const totalPages = Math.ceil(total / limit);

    const payload = {
      data: dataRes.rows,
      pagination: {
        total,
        page,
        limit,
        totalPages,
      },
      mode: env.APP_MODE,
    };

    if (env.APP_MODE === 'optimized') {
      try {
        await redis.set(cacheKey, JSON.stringify(payload), 'EX', 15);
      } catch (cacheErr) {
        console.error('[Cache] Redis error setting list cache:', cacheErr);
      }
      reply.header('x-cache', 'MISS');
    }

    return reply.send(payload);
  });

  // GET /api/events/:id (Public)
  fastify.get('/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const cacheKey = `events:detail:${id}`;

    if (env.APP_MODE === 'optimized') {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          reply.header('x-cache', 'HIT');
          return reply.send(JSON.parse(cached));
        }
      } catch (cacheErr) {
        console.error('[Cache] Redis error reading detail cache:', cacheErr);
      }
    }

    const result = await query<EventRow>('SELECT * FROM events WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return reply.status(404).send({ error: 'Event not found' });
    }

    const event = result.rows[0];
    const payload = { event, mode: env.APP_MODE };

    if (env.APP_MODE === 'optimized') {
      try {
        await redis.set(cacheKey, JSON.stringify(payload), 'EX', 15);
      } catch (cacheErr) {
        console.error('[Cache] Redis error setting detail cache:', cacheErr);
      }
      reply.header('x-cache', 'MISS');
    }

    return reply.send(payload);
  });

  // POST /api/events (ORGANIZER only)
  fastify.post(
    '/',
    { preHandler: [authenticate, authorize(['ORGANIZER'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = createEventSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Validation failed',
          details: parseResult.error.flatten().fieldErrors,
        });
      }

      const { title, description, venue, event_date, total_tickets, price_cents } = parseResult.data;

      const insertResult = await query<EventRow>(
        `INSERT INTO events (organizer_id, title, description, venue, event_date, total_tickets, available_tickets, price_cents, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6, $7, NOW(), NOW())
         RETURNING *`,
        [request.user.id, title, description, venue, new Date(event_date), total_tickets, price_cents]
      );

      const createdEvent = insertResult.rows[0];

      if (env.APP_MODE === 'optimized') {
        await invalidateEventsCache();
      }

      return reply.status(201).send({ event: createdEvent });
    }
  );

  // PUT /api/events/:id (ORGANIZER only, must own event)
  fastify.put(
    '/:id',
    { preHandler: [authenticate, authorize(['ORGANIZER'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const parseResult = updateEventSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Validation failed',
          details: parseResult.error.flatten().fieldErrors,
        });
      }

      const existing = await query<EventRow>('SELECT * FROM events WHERE id = $1', [id]);
      if (existing.rowCount === 0) {
        return reply.status(404).send({ error: 'Event not found' });
      }

      const currentEvent = existing.rows[0];
      if (currentEvent.organizer_id !== request.user.id) {
        return reply.status(403).send({ error: 'Forbidden: You do not have permission to update this event' });
      }

      const updates = parseResult.data;
      const title = updates.title ?? currentEvent.title;
      const description = updates.description ?? currentEvent.description;
      const venue = updates.venue ?? currentEvent.venue;
      const eventDate = updates.event_date ? new Date(updates.event_date) : currentEvent.event_date;
      const priceCents = updates.price_cents ?? currentEvent.price_cents;

      // Calculate new available tickets if total_tickets changed
      let availableTickets = currentEvent.available_tickets;
      let totalTickets = currentEvent.total_tickets;
      if (updates.total_tickets !== undefined) {
        const ticketDiff = updates.total_tickets - currentEvent.total_tickets;
        const newAvailable = currentEvent.available_tickets + ticketDiff;
        if (newAvailable < 0) {
          return reply.status(400).send({
            error: 'Cannot reduce total tickets below the number of currently booked tickets',
          });
        }
        totalTickets = updates.total_tickets;
        availableTickets = newAvailable;
      }

      const updateResult = await query<EventRow>(
        `UPDATE events
         SET title = $1, description = $2, venue = $3, event_date = $4,
             price_cents = $5, total_tickets = $6, available_tickets = $7, updated_at = NOW()
         WHERE id = $8
         RETURNING *`,
        [title, description, venue, eventDate, priceCents, totalTickets, availableTickets, id]
      );

      const updatedEvent = updateResult.rows[0];
      const summary = updates.update_summary || `Event details for "${updatedEvent.title}" have been updated by the organizer.`;

      // Read optional load test delay header
      const headerDelay = request.headers['x-load-test-email-delay-ms'];
      const simulatedDelayMs = headerDelay ? Number(headerDelay) : undefined;

      // Mode-specific email notification strategy
      if (env.APP_MODE === 'baseline') {
        // NAIVE BASELINE: Synchronously query customers and send emails in a loop inside HTTP request!
        const customerResult = await query<{ email: string; name: string }>(
          `SELECT DISTINCT u.email, u.name
           FROM bookings b
           JOIN users u ON b.customer_id = u.id
           WHERE b.event_id = $1 AND b.status = 'CONFIRMED'`,
          [id]
        );

        for (const customer of customerResult.rows) {
          await sendEventUpdateEmail({
            customerEmail: customer.email,
            customerName: customer.name,
            eventTitle: updatedEvent.title,
            venue: updatedEvent.venue,
            eventDate: updatedEvent.event_date,
            updateSummary: summary,
            simulatedDelayMs,
          });
        }
      } else {
        // OPTIMIZED: Cache invalidation + BullMQ asynchronous background fan-out in <2ms!
        await invalidateEventsCache(id);
        await enqueueEventUpdatedFanout({
          eventId: id,
          eventTitle: updatedEvent.title,
          venue: updatedEvent.venue,
          eventDate: updatedEvent.event_date,
          updateSummary: summary,
          simulatedDelayMs,
        });
      }

      return reply.send({ event: updatedEvent });
    }
  );

  // DELETE /api/events/:id (ORGANIZER only, must own event)
  fastify.delete(
    '/:id',
    { preHandler: [authenticate, authorize(['ORGANIZER'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const existing = await query<EventRow>('SELECT organizer_id FROM events WHERE id = $1', [id]);
      if (existing.rowCount === 0) {
        return reply.status(404).send({ error: 'Event not found' });
      }

      if (existing.rows[0].organizer_id !== request.user.id) {
        return reply.status(403).send({ error: 'Forbidden: You do not have permission to delete this event' });
      }

      await query('DELETE FROM events WHERE id = $1', [id]);

      if (env.APP_MODE === 'optimized') {
        await invalidateEventsCache(id);
      }

      return reply.send({ message: 'Event deleted successfully' });
    }
  );

  // GET /api/events/:id/bookings (ORGANIZER only, must own event)
  fastify.get(
    '/:id/bookings',
    { preHandler: [authenticate, authorize(['ORGANIZER'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const existing = await query<EventRow>('SELECT organizer_id FROM events WHERE id = $1', [id]);
      if (existing.rowCount === 0) {
        return reply.status(404).send({ error: 'Event not found' });
      }

      if (existing.rows[0].organizer_id !== request.user.id) {
        return reply.status(403).send({ error: 'Forbidden: You do not own this event' });
      }

      const bookingsRes = await query(
        `SELECT b.id, b.ticket_count, b.total_price_cents, b.status, b.created_at,
                u.id as customer_id, u.name as customer_name, u.email as customer_email
         FROM bookings b
         JOIN users u ON b.customer_id = u.id
         WHERE b.event_id = $1
         ORDER BY b.created_at DESC`,
        [id]
      );

      return reply.send({
        eventId: id,
        bookings: bookingsRes.rows,
      });
    }
  );
}
