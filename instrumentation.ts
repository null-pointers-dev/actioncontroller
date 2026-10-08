// OpenTelemetry -> Azure Monitor (Application Insights) for the web process.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (!process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) return;
  const { useAzureMonitor } = await import('@azure/monitor-opentelemetry');
  useAzureMonitor();
}
