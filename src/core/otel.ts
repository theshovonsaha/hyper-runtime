/**
 * core/otel.ts — OpenTelemetry (OTLP) Tracing Exporter.
 * Ported from python otel.py
 *
 * Emits OTLP spans for model turns, gate holds, and tool executions.
 */

export interface OTLPSpan {
  traceId: string;
  spanId: string;
  name: string;
  startTimeUnixNano: number;
  endTimeUnixNano: number;
  attributes: Record<string, string | number | boolean>;
}

export class OpenTelemetryExporter {
  private spans: OTLPSpan[] = [];

  startSpan(name: string, attributes: Record<string, any> = {}): { end: (extraAttr?: Record<string, any>) => OTLPSpan } {
    const traceId = crypto.randomUUID().replace(/-/g, '');
    const spanId = crypto.randomUUID().slice(0, 16).replace(/-/g, '');
    const startTimeUnixNano = Date.now() * 1_000_000;

    return {
      end: (extraAttr = {}) => {
        const endTimeUnixNano = Date.now() * 1_000_000;
        const span: OTLPSpan = {
          traceId,
          spanId,
          name,
          startTimeUnixNano,
          endTimeUnixNano,
          attributes: { ...attributes, ...extraAttr },
        };
        this.spans.push(span);
        return span;
      },
    };
  }

  getSpans(): OTLPSpan[] {
    return [...this.spans];
  }
}
