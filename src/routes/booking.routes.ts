import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool, query } from '../config/db';
import { env } from '../config/env';
import { invalidateEventsCache } from '../config/redis';
import { authenticate, authorize } from '../middleware/auth';
import { enqueueBookingConfirmation } from '../queues/notification.queue';
import { sendBookingConfirmationEmail } from '../services/email.service';

const createBookingSchema = z.object({
  eventId: z.string().uuid('Invalid eventId UUID format'),
  ticketCount: z.number().int().positive('ticketCount must be at least 1'),
});

interface BookingRow {
  id: string;
  event_id: string;
  customer_id: string;
  ticket_count: number;
  total_price_cents: number;
  status: 'CONFIRMED' | 'CANCELLED';
  created_at: string;
}

interface BookingWithEventRow extends BookingRow {
  title: string;
  venue: string;
  event_date: string;
}

export async function bookingRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/bookings (CUSTOMER only)
  fastify.post(
    '/',
    { preHandler: [authenticate, authorize(['CUSTOMER'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = createBookingSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Validation failed',
          details: parseResult.error.flatten().fieldErrors,
        });
      }

      const { eventId, ticketCount } = parseResult.data;
      const headerDelay = request.headers['x-load-test-email-delay-ms'];
      const simulatedDelayMs = headerDelay ? Number(headerDelay) : undefined;

      // -----------------------------------------------------------------------
      // MODE 1: BASELINE (Naive implementation with row-lock + sync email)
      // -----------------------------------------------------------------------
      if (env.APP_MODE === 'baseline') {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          // Multi-step transaction with SELECT ... FOR UPDATE (holds row lock across roundtrips)
          const eventRes = await client.query<{
            id: string;
            title: string;
            venue: string;
            event_date: string;
            price_cents: number;
            available_tickets: number;
          }>(
            'SELECT id, title, venue, event_date, price_cents, available_tickets FROM events WHERE id = $1 FOR UPDATE',
            [eventId]
          );

          if (eventRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return reply.status(404).send({ error: 'Event not found' });
          }

          const event = eventRes.rows[0];
          if (event.available_tickets < ticketCount) {
            await client.query('ROLLBACK');
            return reply.status(409).send({
              error: 'Insufficient tickets available',
              availableTickets: event.available_tickets,
              requestedTickets: ticketCount,
            });
          }

          const totalPriceCents = event.price_cents * ticketCount;

          await client.query(
            'UPDATE events SET available_tickets = available_tickets - $1, updated_at = NOW() WHERE id = $2',
            [ticketCount, eventId]
          );

          const bookingRes = await client.query<BookingRow>(
            `INSERT INTO bookings (event_id, customer_id, ticket_count, total_price_cents, status)
             VALUES ($1, $2, $3, $4, 'CONFIRMED')
             RETURNING id, event_id, customer_id, ticket_count, total_price_cents, status, created_at`,
            [eventId, request.user.id, ticketCount, totalPriceCents]
          );

          await client.query('COMMIT');
          const booking = bookingRes.rows[0];

          // NAIVE BASELINE BOTTLENECK: Synchronous email delivery inside HTTP request handler!
          await sendBookingConfirmationEmail({
            bookingId: booking.id,
            customerEmail: request.user.email,
            customerName: request.user.name,
            eventTitle: event.title,
            venue: event.venue,
            eventDate: event.event_date,
            ticketCount,
            totalPriceCents,
            simulatedDelayMs,
          });

          return reply.status(201).send({ booking, mode: 'baseline' });
        } catch (txError) {
          await client.query('ROLLBACK');
          throw txError;
        } finally {
          client.release();
        }
      }

      // -----------------------------------------------------------------------
      // MODE 2: OPTIMIZED (Atomic SQL CTE + BullMQ Async Email Queue)
      // -----------------------------------------------------------------------
      const atomicSql = `
        WITH updated_event AS (
          UPDATE events
          SET available_tickets = available_tickets - $1,
              updated_at = NOW()
          WHERE id = $2 AND available_tickets >= $1
          RETURNING id, title, venue, event_date, price_cents, available_tickets
        ),
        new_booking AS (
          INSERT INTO bookings (event_id, customer_id, ticket_count, total_price_cents, status)
          SELECT ue.id, $3, $1, ue.price_cents * $1, 'CONFIRMED'
          FROM updated_event ue
          RETURNING id, event_id, customer_id, ticket_count, total_price_cents, status, created_at
        )
        SELECT nb.*, ue.title, ue.venue, ue.event_date
        FROM new_booking nb
        JOIN updated_event ue ON nb.event_id = ue.id;
      `;

      const result = await query<BookingWithEventRow>(atomicSql, [ticketCount, eventId, request.user.id]);

      if (result.rowCount === 0) {
        // Query event state to provide accurate 404 vs 409 status
        const checkEvent = await query<{ id: string; available_tickets: number }>(
          'SELECT id, available_tickets FROM events WHERE id = $1',
          [eventId]
        );

        if (checkEvent.rowCount === 0) {
          return reply.status(404).send({ error: 'Event not found' });
        }

        return reply.status(409).send({
          error: 'Insufficient tickets available',
          availableTickets: checkEvent.rows[0].available_tickets,
          requestedTickets: ticketCount,
        });
      }

      const bookedRow = result.rows[0];

      // Invalidate Redis caches in background
      await invalidateEventsCache(eventId);

      // Enqueue BullMQ background job in <2ms without blocking the client response
      await enqueueBookingConfirmation({
        bookingId: bookedRow.id,
        customerEmail: request.user.email,
        customerName: request.user.name,
        eventTitle: bookedRow.title,
        venue: bookedRow.venue,
        eventDate: bookedRow.event_date,
        ticketCount: bookedRow.ticket_count,
        totalPriceCents: bookedRow.total_price_cents,
        simulatedDelayMs,
      });

      return reply.status(201).send({
        booking: {
          id: bookedRow.id,
          event_id: bookedRow.event_id,
          customer_id: bookedRow.customer_id,
          ticket_count: bookedRow.ticket_count,
          total_price_cents: bookedRow.total_price_cents,
          status: bookedRow.status,
          created_at: bookedRow.created_at,
        },
        mode: 'optimized',
      });
    }
  );

  // GET /api/bookings/me (CUSTOMER only)
  fastify.get(
    '/me',
    { preHandler: [authenticate, authorize(['CUSTOMER'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const result = await query(
        `SELECT b.id, b.ticket_count, b.total_price_cents, b.status, b.created_at,
                e.id as event_id, e.title as event_title, e.venue as event_venue,
                e.event_date, e.price_cents as ticket_price_cents
         FROM bookings b
         JOIN events e ON b.event_id = e.id
         WHERE b.customer_id = $1
         ORDER BY b.created_at DESC`,
        [request.user.id]
      );

      return reply.send({ bookings: result.rows });
    }
  );

  // POST /api/bookings/:id/cancel (CUSTOMER only, must own booking)
  fastify.post(
    '/:id/cancel',
    { preHandler: [authenticate, authorize(['CUSTOMER'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      const checkBooking = await query<BookingRow>(
        'SELECT * FROM bookings WHERE id = $1',
        [id]
      );

      if (checkBooking.rowCount === 0) {
        return reply.status(404).send({ error: 'Booking not found' });
      }

      const booking = checkBooking.rows[0];

      if (booking.customer_id !== request.user.id) {
        return reply.status(403).send({ error: 'Forbidden: You do not own this booking' });
      }

      if (booking.status === 'CANCELLED') {
        return reply.status(400).send({ error: 'Booking is already cancelled' });
      }

      // Atomically mark CANCELLED and restore available_tickets
      const cancelSql = `
        WITH cancelled_booking AS (
          UPDATE bookings
          SET status = 'CANCELLED'
          WHERE id = $1 AND customer_id = $2 AND status = 'CONFIRMED'
          RETURNING id, event_id, ticket_count, total_price_cents, status, created_at
        )
        UPDATE events e
        SET available_tickets = e.available_tickets + cb.ticket_count,
            updated_at = NOW()
        FROM cancelled_booking cb
        WHERE e.id = cb.event_id
        RETURNING cb.id, cb.event_id, cb.ticket_count, cb.status;
      `;

      const cancelResult = await query(cancelSql, [id, request.user.id]);

      if (cancelResult.rowCount === 0) {
        return reply.status(400).send({ error: 'Unable to cancel booking' });
      }

      if (env.APP_MODE === 'optimized') {
        await invalidateEventsCache(booking.event_id);
      }

      return reply.send({
        message: 'Booking cancelled successfully',
        booking: {
          id: booking.id,
          event_id: booking.event_id,
          status: 'CANCELLED',
          refundedTickets: booking.ticket_count,
        },
      });
    }
  );
}
