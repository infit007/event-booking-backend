const BASE = process.env.TARGET_URL || 'http://localhost:3000';
const CUSTOMER_EMAIL = process.env.CUSTOMER_EMAIL || 'wjsuntha@gmail.com';

async function main() {
  console.log('Testing against:', BASE);

  // 1. Register/Login Organizer
  const orgEmail = `org_${Date.now()}@test.com`;
  const orgRes = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Jayesh Org', email: orgEmail, password: 'Password123!', role: 'ORGANIZER' }),
  });
  const org = await orgRes.json();
  console.log('1. Organizer registered:', orgRes.status);

  // 2. Register or Login Customer (wjsuntha@gmail.com)
  let custRes = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Jayesh Customer', email: CUSTOMER_EMAIL, password: 'Password123!', role: 'CUSTOMER' }),
  });
  let cust = await custRes.json();
  if (custRes.status === 409) {
    custRes = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: CUSTOMER_EMAIL, password: 'Password123!' }),
    });
    cust = await custRes.json();
  }
  console.log('2. Customer ready:', custRes.status, CUSTOMER_EMAIL);

  // 3. RBAC Check: Customer tries to create event -> MUST be 403 Forbidden
  const rbacRes = await fetch(`${BASE}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cust.token}` },
    body: JSON.stringify({
      title: 'Unauthorized Event',
      description: 'Should fail',
      venue: 'Nowhere',
      eventDate: '2026-12-20T18:00:00.000Z',
      totalTickets: 10,
      priceCents: 1000,
    }),
  });
  console.log('3. RBAC check (Customer creating event -> expect 403):', rbacRes.status);

  // 4. Organizer creates Event
  const evRes = await fetch(`${BASE}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${org.token}` },
    body: JSON.stringify({
      title: 'Coldplay Live Mumbai',
      description: 'Music of the Spheres World Tour',
      venue: 'Mumbai Arena',
      eventDate: '2026-12-20T18:00:00.000Z',
      totalTickets: 100,
      priceCents: 5000,
    }),
  });
  const ev = await evRes.json();
  const eventId = ev.event?.id || ev.id;
  console.log('4. Event created:', evRes.status, eventId);

  // 5. Customer books 2 tickets -> Triggers Background Task 1 (Real Email)
  const bookRes = await fetch(`${BASE}/api/bookings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cust.token}` },
    body: JSON.stringify({ eventId, ticketCount: 2 }),
  });
  const book = await bookRes.json();
  console.log('5. Booking created (Task 1 queued):', bookRes.status, book);

  // 6. Organizer updates Event -> Triggers Background Task 2 (Real Email)
  const updRes = await fetch(`${BASE}/api/events/${eventId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${org.token}` },
    body: JSON.stringify({ venue: 'DY Patil Stadium Mumbai' }),
  });
  const upd = await updRes.json();
  console.log('6. Event updated (Task 2 queued):', updRes.status, upd);

  // 7. Wait 3s and check notification logs
  await new Promise((r) => setTimeout(r, 3000));
  const logRes = await fetch(`${BASE}/api/notifications/logs`, {
    headers: { Authorization: `Bearer ${org.token}` },
  });
  const logs = await logRes.json();
  console.log('7. Notification logs:', JSON.stringify(logs, null, 2));
}

main().catch(console.error);
