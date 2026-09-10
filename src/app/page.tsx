/**
 * Service index. Deliberately static and dependency-free: this page must render
 * even when the database is unreachable, so it is never mistaken for a health
 * signal. Use /api/health for that.
 */

const ENDPOINTS = [
  {
    method: 'POST',
    path: '/api/webhook/tive',
    auth: 'X-API-Key',
    description: 'Ingest a Tive telemetry payload. Returns 201 created, or 200 if already stored.',
  },
  {
    method: 'GET',
    path: '/api/health',
    auth: 'none',
    description: 'Liveness and database connectivity. 503 when degraded.',
  },
];

export default function Home() {
  return (
    <main>
      <h1>PAXAFE Integration API</h1>
      <p className="lede">
        Receives IoT telemetry webhooks, normalises them to the PAXAFE canonical sensor and
        location formats, and persists them to PostgreSQL.
      </p>

      <h2>Endpoints</h2>
      <table>
        <thead>
          <tr>
            <th>Method</th>
            <th>Path</th>
            <th>Auth</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {ENDPOINTS.map((endpoint) => (
            <tr key={endpoint.path}>
              <td>
                <code>{endpoint.method}</code>
              </td>
              <td>
                <code>{endpoint.path}</code>
              </td>
              <td>{endpoint.auth}</td>
              <td>{endpoint.description}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Providers</h2>
      <p>
        Tive. Each provider is an adapter that validates its own payload shape and targets the
        shared canonical format, so adding one does not touch the ingestion pipeline.
      </p>

      <footer>
        Documentation and design decisions are in the repository README.
      </footer>
    </main>
  );
}
