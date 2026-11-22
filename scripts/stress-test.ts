import autocannon from 'autocannon';
import dotenv from 'dotenv';

dotenv.config();

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '50', 10);
const DURATION = parseInt(process.env.DURATION || '10', 10);
const TEST_ORGANIZER_EMAIL = process.env.TEST_ORGANIZER_EMAIL || 'stress-organizer@example.com';
const TEST_CUSTOMER_EMAIL = process.env.TEST_CUSTOMER_EMAIL || 'stress-customer@example.com';
const TEST_PASSWORD = 'StressPassword123!';
const INITIAL_TICKETS = 100000;

async function request(path: string, options: RequestInit = {}) {
  const url = `${TARGET_URL}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  return { status: response.status, ok: response.ok, data: json };
}

async function getOrRegisterUser(name: string, email: string, role: 'ORGANIZER' | 'CUSTOMER'): Promise<string> {
  // Attempt login first
  const loginRes = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
  });

  if (loginRes.ok && loginRes.data?.token) {
    return loginRes.data.token;
  }

  // If login failed, register
  const regRes = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name, email, password: TEST_PASSWORD, role }),
  });

  if (regRes.ok && regRes.data?.token) {
    return regRes.data.token;
  }

  throw new Error(`Failed to authenticate ${role} (${email}): ${JSON.stringify(regRes.data)}`);
}

async function run() {
  console.log(`================================================================`);
  console.log(`⚡ EVENT BOOKING SYSTEM - CONCURRENCY STRESS TEST`);
  console.log(`================================================================`);
  console.log(`Target: ${TARGET_URL}`);
  console.log(`Concurrency: ${CONCURRENCY} connections`);
  console.log(`Duration: ${DURATION} seconds`);

  // 1. Health check
  console.log(`\n[Step 1/5] Verifying API Health...`);
  const health = await request('/health');
  if (!health.ok) {
    throw new Error(`Target is not healthy: HTTP ${health.status} - ${JSON.stringify(health.data)}`);
  }
  const appMode: string = health.data?.mode || 'unknown';
  console.log(`Server is HEALTHY. Active mode: ${appMode.toUpperCase()}`);

  // 2. Setup Organizer
  console.log(`\n[Step 2/5] Setting up Organizer & Event (${INITIAL_TICKETS.toLocaleString()} tickets)...`);
  const organizerToken = await getOrRegisterUser('Stress Organizer', TEST_ORGANIZER_EMAIL, 'ORGANIZER');

  const eventRes = await request('/api/events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${organizerToken}` },
    body: JSON.stringify({
      title: `Stress Test Concert ${Date.now()}`,
      description: 'High concurrency benchmark event to verify zero overselling.',
      venue: 'Cloud Concurrency Arena, Hall 1',
      event_date: new Date(Date.now() + 86400000 * 30).toISOString(),
      total_tickets: INITIAL_TICKETS,
      price_cents: 2500, // $25.00
    }),
  });

  if (!eventRes.ok || !eventRes.data?.event?.id) {
    throw new Error(`Failed to create event: ${JSON.stringify(eventRes.data)}`);
  }

  const eventId: string = eventRes.data.event.id;
  console.log(`Event Created: ID ${eventId} with ${INITIAL_TICKETS.toLocaleString()} available tickets.`);

  // 3. Setup Customer
  console.log(`\n[Step 3/5] Setting up Customer account...`);
  const customerToken = await getOrRegisterUser('Stress Customer', TEST_CUSTOMER_EMAIL, 'CUSTOMER');
  console.log(`Customer authenticated successfully.`);

  // 4. Run Autocannon
  console.log(`\n[Step 4/5] Launching Autocannon stress barrage for ${DURATION}s...`);
  console.log(`Sending concurrent POST /api/bookings requests...`);

  const results = await autocannon({
    url: `${TARGET_URL}/api/bookings`,
    connections: CONCURRENCY,
    duration: DURATION,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${customerToken}`,
      'x-load-test-email-delay-ms': '250',
    },
    body: JSON.stringify({
      eventId,
      ticketCount: 1,
    }),
  });

  // 5. Results & Integrity Verification
  console.log(`\n================================================================`);
  console.log(`📊 BENCHMARK PERFORMANCE RESULTS`);
  console.log(`================================================================`);

  const summary = {
    'Execution Mode': appMode.toUpperCase(),
    'Concurrent Connections': CONCURRENCY,
    'Duration (s)': DURATION,
    'Requests / Sec (Avg)': results.requests.average,
    'Latency p50 (ms)': results.latency.p50,
    'Latency p95 (ms)': results.latency.p95,
    'Latency p99 (ms)': results.latency.p99,
    '2xx Responses (Success)': results['2xx'],
    'Non-2xx Responses': results.non2xx,
    'Errors / Timeouts': results.errors + results.timeouts,
  };

  console.table(summary);

  console.log(`\n[Step 5/5] Auditing Data Integrity & Zero Overselling...`);
  const finalEventRes = await request(`/api/events/${eventId}`);
  if (!finalEventRes.ok || !finalEventRes.data?.event) {
    throw new Error(`Failed to fetch final event state: ${JSON.stringify(finalEventRes.data)}`);
  }

  const finalAvailableTickets: number = finalEventRes.data.event.available_tickets;
  const ticketsSold = INITIAL_TICKETS - finalAvailableTickets;
  const successfulBookings = results['2xx'];

  console.log(`----------------------------------------------------------------`);
  console.log(`Initial Available Tickets:    ${INITIAL_TICKETS.toLocaleString()}`);
  console.log(`Remaining Available Tickets:  ${finalAvailableTickets.toLocaleString()}`);
  console.log(`Database Tickets Deducted:    ${ticketsSold.toLocaleString()}`);
  console.log(`HTTP 2xx Booking Responses:   ${successfulBookings.toLocaleString()}`);
  console.log(`----------------------------------------------------------------`);

  if (ticketsSold === successfulBookings) {
    console.log(`\n✅ [DATA INTEGRITY PASSED] ZERO OVERSELLING VERIFIED!`);
    console.log(`The number of deducted database tickets (${ticketsSold}) exactly matches`);
    console.log(`the count of 2xx HTTP confirmations (${successfulBookings}). No race conditions occurred.`);
  } else {
    console.error(`\n❌ [DATA INTEGRITY FAILED] Discrepancy detected!`);
    console.error(`Tickets deducted: ${ticketsSold} vs 2xx responses: ${successfulBookings}`);
    process.exitCode = 1;
  }
  console.log(`================================================================\n`);
}

run().catch((err) => {
  console.error('[StressTest] Fatal Error:', err);
  process.exit(1);
});
