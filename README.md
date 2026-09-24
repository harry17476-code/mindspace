# MindSpace secure prototype

This version adds:
- Owner-only listener access using MINDSPACE_OWNER_KEY.
- Separate Socket.IO rooms for every 1-to-1 conversation.
- Messages are not broadcast globally and are not persisted by this prototype.
- Helmet security headers.
- Basic HTTP rate limiting.
- Message-size limits and input trimming.

## Run
1. Install Node.js LTS.
2. Open CMD in this folder.
3. Run `npm install`.
4. Set a private owner key for this session:
   Windows CMD:
   `set MINDSPACE_OWNER_KEY=choose-a-long-random-secret`
5. Run `npm start`.
6. Open http://localhost:3000.

## Important
No web application can honestly be guaranteed "impossible to hack." Before public launch, use HTTPS, secure authentication, a proper secret-management system, database access controls if storing data, backups, logging/monitoring, vulnerability testing, moderation, report/block, privacy/retention controls, age-safety protections, and professional/legal review.

This prototype intentionally does not persist chat messages to a database. If the server restarts, the messages disappear.

Because this service involves people discussing emotional or mental-health concerns, do not present the listener as a licensed therapist unless they actually are one. Public launch also needs a clear crisis-escalation process and protections for minors.
