/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { DiagConsoleLogger, DiagLogLevel, diag } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { CompressionAlgorithm } from '@opentelemetry/otlp-exporter-base';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { Resource } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
} from '@opentelemetry/sdk-trace-node';
import {
  BatchLogRecordProcessor,
  ConsoleLogRecordExporter,
} from '@opentelemetry/sdk-logs';
import {
  ConsoleMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { Config } from '../config/config.js';
import { SERVICE_NAME } from './constants.js';
import { initializeMetrics } from './metrics.js';
import { ClearcutLogger } from './clearcut-logger/clearcut-logger.js';
import {
  FileLogExporter,
  FileMetricExporter,
  FileSpanExporter,
} from './file-exporters.js';

// For troubleshooting, set the log level to DiagLogLevel.DEBUG
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);

let sdk: NodeSDK | undefined;
let telemetryInitialized = false;

export function isTelemetrySdkInitialized(): boolean {
  return telemetryInitialized;
}

function parseGrpcEndpoint(
  otlpEndpointSetting: string | undefined,
): string | undefined {
  if (!otlpEndpointSetting) {
    return undefined;
  }
  // Trim leading/trailing quotes that might come from env variables
  const trimmedEndpoint = otlpEndpointSetting.replace(/^["']|["']$/g, '');

  try {
    const url = new URL(trimmedEndpoint);
    // OTLP gRPC exporters expect an endpoint in the format scheme://host:port
    // The `origin` property provides this, stripping any path, query, or hash.
    return url.origin;
  } catch (error) {
    diag.error('Invalid OTLP endpoint URL provided:', trimmedEndpoint, error);
    return undefined;
  }
}

export function initializeTelemetry(config: Config): void {
  if (telemetryInitialized || !config.getTelemetryEnabled()) {
    return;
  }

  const resource = new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: SERVICE_NAME,
    [SemanticResourceAttributes.SERVICE_VERSION]: process.version,
    'session.id': config.getSessionId(),
  });

  // EXTERNAL TELEMETRY DISABLED: Force local-only exporters to prevent data from leaving the computer
  // This keeps local metrics collection but disables external OTLP/gRPC data transmission
  // However, we do support file output for local inspection
  const telemetryOutfile = config.getTelemetryOutfile();

  const spanExporter = telemetryOutfile 
    ? new FileSpanExporter(telemetryOutfile)
    : new ConsoleSpanExporter(); // Local console output only
  const logExporter = telemetryOutfile
    ? new FileLogExporter(telemetryOutfile)
    : new ConsoleLogRecordExporter(); // Local console output only
  const metricReader = new PeriodicExportingMetricReader({
    exporter: telemetryOutfile
      ? new FileMetricExporter(telemetryOutfile)
      : new ConsoleMetricExporter(), // Local console output only
    exportIntervalMillis: 10000,
  });

  /*
  EXTERNAL TELEMETRY DISABLED - The original upstream code below is commented out
  to prevent any external data transmission while keeping local telemetry functional:
  
  const otlpEndpoint = config.getTelemetryOtlpEndpoint();
  const grpcParsedEndpoint = parseGrpcEndpoint(otlpEndpoint);
  const useOtlp = !!grpcParsedEndpoint;

  const spanExporter = useOtlp
    ? new OTLPTraceExporter({
        url: grpcParsedEndpoint,
        compression: CompressionAlgorithm.GZIP,
      })
    : telemetryOutfile
      ? new FileSpanExporter(telemetryOutfile)
      : new ConsoleSpanExporter();
  const logExporter = useOtlp
    ? new OTLPLogExporter({
        url: grpcParsedEndpoint,
        compression: CompressionAlgorithm.GZIP,
      })
    : telemetryOutfile
      ? new FileLogExporter(telemetryOutfile)
      : new ConsoleLogRecordExporter();
  const metricReader = useOtlp
    ? new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: grpcParsedEndpoint,
          compression: CompressionAlgorithm.GZIP,
        }),
        exportIntervalMillis: 10000,
      })
    : telemetryOutfile
      ? new PeriodicExportingMetricReader({
          exporter: new FileMetricExporter(telemetryOutfile),
          exportIntervalMillis: 10000,
        })
      : new PeriodicExportingMetricReader({
          exporter: new ConsoleMetricExporter(),
          exportIntervalMillis: 10000,
        });
  */

  sdk = new NodeSDK({
    resource,
    spanProcessors: [new BatchSpanProcessor(spanExporter)],
    logRecordProcessor: new BatchLogRecordProcessor(logExporter),
    metricReader,
    instrumentations: [new HttpInstrumentation()],
  });

  try {
    sdk.start();
    console.log('OpenTelemetry SDK started successfully.');
    telemetryInitialized = true;
    initializeMetrics(config);
  } catch (error) {
    console.error('Error starting OpenTelemetry SDK:', error);
  }

  process.on('SIGTERM', shutdownTelemetry);
  process.on('SIGINT', shutdownTelemetry);
}

export async function shutdownTelemetry(): Promise<void> {
  if (!telemetryInitialized || !sdk) {
    return;
  }
  try {
    ClearcutLogger.getInstance()?.shutdown();
    await sdk.shutdown();
    console.log('OpenTelemetry SDK shut down successfully.');
  } catch (error) {
    console.error('Error shutting down SDK:', error);
  } finally {
    telemetryInitialized = false;
  }
}
