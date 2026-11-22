import { Resend } from 'resend';
import nodemailer from 'nodemailer';
import { env } from '../config/env';
import { query } from '../config/db';

let resendClient: Resend | null = null;
if (env.EMAIL_PROVIDER === 'resend') {
  if (env.RESEND_API_KEY) {
    resendClient = new Resend(env.RESEND_API_KEY);
  } else {
    console.warn('[EmailService] EMAIL_PROVIDER is "resend" but RESEND_API_KEY is missing. Real email sending will fail unless configured.');
  }
}

let smtpTransporter: nodemailer.Transporter | null = null;
if (env.EMAIL_PROVIDER === 'smtp') {
  if (env.SMTP_HOST) {
    smtpTransporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT || 587,
      secure: env.SMTP_SECURE,
      auth:
        env.SMTP_USER && env.SMTP_PASS
          ? {
              user: env.SMTP_USER,
              pass: env.SMTP_PASS,
            }
          : undefined,
    });
  } else {
    console.warn('[EmailService] EMAIL_PROVIDER is "smtp" but SMTP_HOST is not configured.');
  }
}

export interface SendEmailOptions {
  type: 'BOOKING_CONFIRMATION' | 'EVENT_UPDATE';
  recipientEmail: string;
  subject: string;
  html: string;
  simulatedDelayMs?: number;
}

export interface SendEmailResult {
  success: boolean;
  providerId?: string;
  error?: string;
}

export async function logNotificationAttempt(
  type: string,
  recipientEmail: string,
  subject: string,
  status: 'SENT' | 'FAILED',
  providerId?: string | null,
  errorMessage?: string | null
): Promise<void> {
  try {
    await query(
      `INSERT INTO notification_logs (type, recipient_email, subject, status, provider_id, error_message, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [type, recipientEmail, subject, status, providerId || null, errorMessage || null]
    );
  } catch (dbErr) {
    console.error('[EmailService] Failed to record notification_log:', dbErr);
  }
}

export async function sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
  const { type, recipientEmail, subject, html, simulatedDelayMs } = options;

  // Stress testing protection: simulate realistic 250ms network I/O if explicitly toggled on
  if (env.LOAD_TEST_SKIP_EXTERNAL_EMAIL) {
    const delay = simulatedDelayMs !== undefined && !isNaN(simulatedDelayMs) ? simulatedDelayMs : 250;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const simulatedId = `sim-stress-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    await logNotificationAttempt(type, recipientEmail, subject, 'SENT', simulatedId, null);
    return { success: true, providerId: simulatedId };
  }

  // Real Email Provider Sending
  try {
    if (env.EMAIL_PROVIDER === 'resend') {
      if (!resendClient) {
        throw new Error('Resend client is not initialized. Please set RESEND_API_KEY.');
      }

      const response = await resendClient.emails.send({
        from: env.EMAIL_FROM,
        to: recipientEmail,
        subject,
        html,
      });

      if (response.error) {
        throw new Error(`Resend API Error: ${response.error.name} - ${response.error.message}`);
      }

      const providerId = response.data?.id || `resend-${Date.now()}`;
      await logNotificationAttempt(type, recipientEmail, subject, 'SENT', providerId, null);
      return { success: true, providerId };
    } else {
      // SMTP Provider via Nodemailer
      if (!smtpTransporter) {
        throw new Error('Nodemailer SMTP transporter is not configured. Please set SMTP_HOST, SMTP_PORT, etc.');
      }

      const info = await smtpTransporter.sendMail({
        from: env.EMAIL_FROM,
        to: recipientEmail,
        subject,
        html,
      });

      const providerId = info.messageId || `smtp-${Date.now()}`;
      await logNotificationAttempt(type, recipientEmail, subject, 'SENT', providerId, null);
      return { success: true, providerId };
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[EmailService] Delivery failed to ${recipientEmail} [${subject}]:`, errorMsg);
    await logNotificationAttempt(type, recipientEmail, subject, 'FAILED', null, errorMsg);
    return { success: false, error: errorMsg };
  }
}

export interface BookingConfirmationParams {
  bookingId: string;
  customerEmail: string;
  customerName: string;
  eventTitle: string;
  venue: string;
  eventDate: string | Date;
  ticketCount: number;
  totalPriceCents: number;
  simulatedDelayMs?: number;
}

export async function sendBookingConfirmationEmail(params: BookingConfirmationParams): Promise<SendEmailResult> {
  const formattedDate = new Date(params.eventDate).toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  const formattedPrice = `$${(params.totalPriceCents / 100).toFixed(2)} USD`;

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f6f8; margin: 0; padding: 20px; color: #1a202c; }
        .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05); }
        .header { background: #2563eb; color: #ffffff; padding: 24px; text-align: center; }
        .header h1 { margin: 0 0 8px 0; font-size: 24px; }
        .content { padding: 32px 24px; }
        .receipt-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 20px; margin: 20px 0; }
        .row { display: flex; justify-content: space-between; margin-bottom: 12px; font-size: 15px; }
        .row:last-child { margin-bottom: 0; }
        .label { color: #64748b; font-weight: 500; }
        .value { color: #0f172a; font-weight: 600; text-align: right; }
        .total-row { border-top: 1px solid #cbd5e1; padding-top: 12px; margin-top: 12px; font-size: 17px; }
        .footer { text-align: center; padding: 20px; font-size: 13px; color: #94a3b8; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Booking Confirmed!</h1>
          <p>Your ticket is secured. See you at the event!</p>
        </div>
        <div class="content">
          <p>Hello <strong>${params.customerName}</strong>,</p>
          <p>Thank you for your purchase. Here is your official booking confirmation details:</p>
          
          <div class="receipt-card">
            <div class="row">
              <span class="label">Booking Reference:</span>
              <span class="value" style="font-family: monospace;">${params.bookingId}</span>
            </div>
            <div class="row">
              <span class="label">Event:</span>
              <span class="value">${params.eventTitle}</span>
            </div>
            <div class="row">
              <span class="label">Venue:</span>
              <span class="value">${params.venue}</span>
            </div>
            <div class="row">
              <span class="label">Date & Time:</span>
              <span class="value">${formattedDate}</span>
            </div>
            <div class="row">
              <span class="label">Tickets:</span>
              <span class="value">${params.ticketCount} ticket(s)</span>
            </div>
            <div class="row total-row">
              <span class="label">Total Paid:</span>
              <span class="value" style="color: #16a34a;">${formattedPrice}</span>
            </div>
          </div>
          
          <p>Please present this booking confirmation or show your booking ID at check-in.</p>
        </div>
        <div class="footer">
          &copy; ${new Date().getFullYear()} Event Booking System. All rights reserved.
        </div>
      </div>
    </body>
    </html>
  `;

  return sendEmail({
    type: 'BOOKING_CONFIRMATION',
    recipientEmail: params.customerEmail,
    subject: `Booking Confirmed: ${params.eventTitle} (#${params.bookingId.substring(0, 8)})`,
    html,
    simulatedDelayMs: params.simulatedDelayMs,
  });
}

export interface EventUpdateParams {
  customerEmail: string;
  customerName: string;
  eventTitle: string;
  venue: string;
  eventDate: string | Date;
  updateSummary: string;
  simulatedDelayMs?: number;
}

export async function sendEventUpdateEmail(params: EventUpdateParams): Promise<SendEmailResult> {
  const formattedDate = new Date(params.eventDate).toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f6f8; margin: 0; padding: 20px; color: #1a202c; }
        .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05); }
        .header { background: #d97706; color: #ffffff; padding: 24px; text-align: center; }
        .header h1 { margin: 0 0 8px 0; font-size: 24px; }
        .content { padding: 32px 24px; }
        .alert-card { background: #fffbeb; border: 1px solid #fde68a; border-radius: 6px; padding: 20px; margin: 20px 0; }
        .info-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 20px; margin: 20px 0; }
        .row { display: flex; justify-content: space-between; margin-bottom: 12px; font-size: 15px; }
        .row:last-child { margin-bottom: 0; }
        .label { color: #64748b; font-weight: 500; }
        .value { color: #0f172a; font-weight: 600; text-align: right; }
        .footer { text-align: center; padding: 20px; font-size: 13px; color: #94a3b8; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Important Event Update</h1>
          <p>${params.eventTitle}</p>
        </div>
        <div class="content">
          <p>Hello <strong>${params.customerName}</strong>,</p>
          <p>The organizer has updated the details for an event you have booked tickets for.</p>
          
          <div class="alert-card">
            <strong>Update Details:</strong>
            <p style="margin: 8px 0 0 0; color: #92400e;">${params.updateSummary}</p>
          </div>

          <div class="info-card">
            <div class="row">
              <span class="label">Event:</span>
              <span class="value">${params.eventTitle}</span>
            </div>
            <div class="row">
              <span class="label">Current Venue:</span>
              <span class="value">${params.venue}</span>
            </div>
            <div class="row">
              <span class="label">Current Date:</span>
              <span class="value">${formattedDate}</span>
            </div>
          </div>
          
          <p>Your existing booking reference and tickets remain fully valid.</p>
        </div>
        <div class="footer">
          &copy; ${new Date().getFullYear()} Event Booking System. All rights reserved.
        </div>
      </div>
    </body>
    </html>
  `;

  return sendEmail({
    type: 'EVENT_UPDATE',
    recipientEmail: params.customerEmail,
    subject: `Important Update: ${params.eventTitle}`,
    html,
    simulatedDelayMs: params.simulatedDelayMs,
  });
}
