import { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export type UserRole = 'ORGANIZER' | 'CUSTOMER';

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
  name: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser;
  }
}

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.status(401).send({
      error: 'Unauthorized: Missing or invalid authorization token',
    });
    return;
  }

  const token = authHeader.substring(7).trim();

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as AuthUser;
    request.user = {
      id: decoded.id,
      email: decoded.email,
      role: decoded.role,
      name: decoded.name,
    };
  } catch (err) {
    reply.status(401).send({
      error: 'Unauthorized: Token is invalid or expired',
    });
    return;
  }
}

export function authorize(roles: UserRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.user) {
      reply.status(401).send({
        error: 'Unauthorized: Authentication required',
      });
      return;
    }

    if (!roles.includes(request.user.role)) {
      reply.status(403).send({
        error: `Forbidden: Access requires one of the following roles: [${roles.join(', ')}]`,
      });
      return;
    }
  };
}
