import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { query } from '../config/db';
import { env } from '../config/env';
import { UserRole } from '../middleware/auth';

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(120),
  email: z.string().trim().email('Invalid email address').max(255),
  password: z.string().min(6, 'Password must be at least 6 characters').max(100),
  role: z.enum(['ORGANIZER', 'CUSTOMER'] as const),
});

const loginSchema = z.object({
  email: z.string().trim().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: UserRole;
  created_at: string;
}

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/auth/register
  fastify.post('/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = registerSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parseResult.error.flatten().fieldErrors,
      });
    }

    const { name, email, password, role } = parseResult.data;
    const normalizedEmail = email.toLowerCase();

    // Check existing email
    const existingUser = await query<UserRow>('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existingUser.rowCount && existingUser.rowCount > 0) {
      return reply.status(409).send({
        error: 'Email is already registered',
      });
    }

    // Hash password & insert
    const passwordHash = await bcrypt.hash(password, 10);
    const insertResult = await query<UserRow>(
      `INSERT INTO users (name, email, password_hash, role, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING id, name, email, role, created_at`,
      [name, normalizedEmail, passwordHash, role]
    );

    const user = insertResult.rows[0];

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        name: user.name,
      },
      env.JWT_SECRET,
      { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] }
    );

    return reply.status(201).send({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        createdAt: user.created_at,
      },
      token,
    });
  });

  // POST /api/auth/login
  fastify.post('/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = loginSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parseResult.error.flatten().fieldErrors,
      });
    }

    const { email, password } = parseResult.data;
    const normalizedEmail = email.toLowerCase();

    const userResult = await query<UserRow>(
      'SELECT id, name, email, password_hash, role, created_at FROM users WHERE email = $1',
      [normalizedEmail]
    );

    if (userResult.rowCount === 0) {
      return reply.status(401).send({
        error: 'Invalid email or password',
      });
    }

    const user = userResult.rows[0];
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      return reply.status(401).send({
        error: 'Invalid email or password',
      });
    }

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        name: user.name,
      },
      env.JWT_SECRET,
      { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] }
    );

    return reply.status(200).send({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        createdAt: user.created_at,
      },
      token,
    });
  });
}
