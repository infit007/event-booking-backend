import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  APP_MODE: z.enum(['baseline', 'optimized']).default('optimized'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  JWT_SECRET: z.string().min(8, 'JWT_SECRET must be at least 8 characters long').default('super-secret-jwt-key-replace-in-production'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  EMAIL_PROVIDER: z.enum(['resend', 'smtp']).default('resend'),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('onboarding@resend.dev'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_SECURE: z.coerce.boolean().default(false),
  LOAD_TEST_SKIP_EXTERNAL_EMAIL: z.coerce.boolean().default(false),
});

const parseEnv = () => {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const errorDetails = result.error.errors
      .map((err) => `  - ${err.path.join('.')}: ${err.message}`)
      .join('\n');
    console.error('Environment variable validation failed:\n' + errorDetails);
    throw new Error('Invalid environment configuration');
  }
  return result.data;
};

export const env = parseEnv();
export type Env = z.infer<typeof envSchema>;
