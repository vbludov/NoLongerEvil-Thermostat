import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import { environment, validateEnvironment } from './config/environment';
import { initializeFileLogging } from './lib/logger';
import { DeviceStateService } from './services/DeviceStateService';
import { SubscriptionManager } from './services/SubscriptionManager';
import { WeatherService } from './services/WeatherService';
import { resolveDeviceSerial } from './lib/serialParser';
import { handleTransportGet, handleTransportSubscribe, handlePut } from './routes/nest/transport';
import { handleEntry } from './routes/nest/entry';
import { handlePassphrase } from './routes/nest/passphrase';
import { handleProInfo } from './routes/nest/proInfo';
import { handlePing } from './routes/nest/ping';
import { handleUpload } from './routes/nest/upload';
import { handleWeather } from './routes/nest/weather';
import { handleCommand } from './routes/control/command';
import { handleStatus, handleNotifyDevice } from './routes/control/status';
import { normalizeUrl } from './middleware/urlNormalizer';
import { logRequest, createResponseLogger, initDebugLogsDir } from './middleware/debugLogger';
import { IntegrationManager } from './integrations/IntegrationManager';
import { AbstractDeviceStateManager } from './services/AbstractDeviceStateManager';
import { SQLite3Service } from './services/SQLite3Service';
import { DeviceInitialization } from './integrations/DeviceInitialization';
import { DeviceAvailabilityWatchdog } from './services/DeviceAvailability';

validateEnvironment();

initializeFileLogging();
initDebugLogsDir();

const deviceStateManager: AbstractDeviceStateManager = new SQLite3Service()
const deviceStateService = new DeviceStateService(deviceStateManager);
const subscriptionManager = new SubscriptionManager();
const weatherService = new WeatherService(deviceStateManager);
const integrationManager = new IntegrationManager();
const deviceInitialization = new DeviceInitialization();
const availabilityWatchdog = new DeviceAvailabilityWatchdog();

type UiLogEntry = {
  ts: number;
  api: 'device' | 'control';
  method: string;
  path: string;
  statusCode?: number;
  durationMs?: number;
  serial?: string;
};

const UI_LOG_MAX_ENTRIES = 500;
const uiLogBuffer: UiLogEntry[] = [];
const uiLogSseClients = new Set<http.ServerResponse>();

function uiLogPush(entry: UiLogEntry): void {
  uiLogBuffer.push(entry);
  while (uiLogBuffer.length > UI_LOG_MAX_ENTRIES) {
    uiLogBuffer.shift();
  }

  const payload = JSON.stringify(entry);
  for (const client of uiLogSseClients) {
    if (client.writableEnded || client.destroyed) {
      uiLogSseClients.delete(client);
      continue;
    }
    try {
      client.write(`data: ${payload}\n\n`);
    } catch {
      uiLogSseClients.delete(client);
    }
  }
}

/**
 * Parse JSON request body
 */
function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        resolve(parsed);
      } catch (error) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Send JSON response
 */
function sendJson(res: http.ServerResponse, statusCode: number, data: any): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Send error response
 */
function sendError(res: http.ServerResponse, statusCode: number, message: string): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

function sendHtml(res: http.ServerResponse, statusCode: number, html: string): void {
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

const UI_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>No Longer Evil - Devices</title>
    <style>
      :root { color-scheme: light dark; }
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 24px; }
      .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
      input, button, select { font: inherit; padding: 8px 10px; }
      button { cursor: pointer; }
      pre { padding: 12px; border: 1px solid rgba(127,127,127,0.3); overflow: auto; }
      table { border-collapse: collapse; width: 100%; }
      th, td { text-align: left; padding: 8px; border-bottom: 1px solid rgba(127,127,127,0.3); }
      .muted { opacity: 0.8; }
    </style>
  </head>
  <body>
    <h1>No Longer Evil</h1>
    <p class="muted">GUI served by the Device API on port 80. Device endpoints under <code>/nest/*</code> remain unchanged.</p>

    <h2>Known Devices</h2>
    <div class="row">
      <button id="refresh">Refresh</button>
      <span id="status" class="muted"></span>
    </div>
    <table id="devicesTable" aria-label="devices">
      <thead>
        <tr>
          <th>Serial</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>

    <h2>Pair / Add device (generate entry key)</h2>
    <div class="row">
      <input id="serialInput" placeholder="Enter device serial" />
      <button id="genKey">Generate entry key</button>
      <span id="entryKeyOut" class="muted"></span>
    </div>

    <h2>Device State</h2>
    <pre id="deviceState">Select a device to view state.</pre>

    <h2>Live Request Log</h2>
    <p class="muted">Shows recent requests handled by this server. Auto-updates in real time.</p>
    <pre id="liveLog">Connecting...</pre>

    <script>
      const statusEl = document.getElementById('status');
      const tbody = document.querySelector('#devicesTable tbody');
      const deviceStateEl = document.getElementById('deviceState');
      const serialInput = document.getElementById('serialInput');
      const entryKeyOut = document.getElementById('entryKeyOut');
      const liveLogEl = document.getElementById('liveLog');

      function setStatus(msg) { statusEl.textContent = msg; }

      async function api(path, options) {
        const res = await fetch(path, options);
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(text || ('HTTP ' + res.status));
        }
        const ct = res.headers.get('content-type') || '';
        return ct.includes('application/json') ? res.json() : res.text();
      }

      async function refreshDevices() {
        setStatus('Loading...');
        tbody.innerHTML = '';
        try {
          const data = await api('/ui/api/devices');
          const devices = data.devices || [];
          if (devices.length === 0) {
            const tr = document.createElement('tr');
            tr.innerHTML = '<td colspan="2" class="muted">No devices have reported state yet.</td>';
            tbody.appendChild(tr);
          } else {
            for (const serial of devices) {
              const tr = document.createElement('tr');
              const tdSerial = document.createElement('td');
              tdSerial.textContent = serial;
              const tdActions = document.createElement('td');
              const viewBtn = document.createElement('button');
              viewBtn.textContent = 'View state';
              viewBtn.onclick = () => loadDeviceState(serial);
              tdActions.appendChild(viewBtn);
              tr.appendChild(tdSerial);
              tr.appendChild(tdActions);
              tbody.appendChild(tr);
            }
          }
          setStatus('Loaded ' + devices.length + ' device(s).');
        } catch (e) {
          setStatus('Error: ' + e.message);
        }
      }

      async function loadDeviceState(serial) {
        setStatus('Loading state for ' + serial + '...');
        try {
          const data = await api('/ui/api/device?serial=' + encodeURIComponent(serial));
          deviceStateEl.textContent = JSON.stringify(data, null, 2);
          setStatus('Loaded state for ' + serial + '.');
        } catch (e) {
          deviceStateEl.textContent = 'Failed to load state: ' + e.message;
          setStatus('Error: ' + e.message);
        }
      }

      async function generateEntryKey(serial) {
        entryKeyOut.textContent = '';
        setStatus('Generating entry key...');
        try {
          const data = await api('/ui/api/entry-key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ serial })
          });
          entryKeyOut.textContent = data && data.code
            ? ('Entry key: ' + data.code + ' (expires: ' + new Date(data.expiresAt).toLocaleString() + ')')
            : 'No key returned.';
          setStatus('Entry key generated.');
        } catch (e) {
          entryKeyOut.textContent = 'Error: ' + e.message;
          setStatus('Error: ' + e.message);
        }
      }

      document.getElementById('refresh').addEventListener('click', refreshDevices);
      document.getElementById('genKey').addEventListener('click', () => generateEntryKey(serialInput.value.trim()));

      function formatLogLine(e) {
        const d = new Date(e.ts);
        const t = d.toLocaleTimeString();
        const serial = e.serial ? (' serial=' + e.serial) : '';
        const status = (typeof e.statusCode === 'number') ? (' ' + e.statusCode) : '';
        const dur = (typeof e.durationMs === 'number') ? (' ' + e.durationMs + 'ms') : '';
        return '[' + t + '] ' + e.api.toUpperCase() + ' ' + e.method + ' ' + e.path + status + dur + serial;
      }

      function appendLog(entry) {
        if (!liveLogEl) return;
        const lines = liveLogEl.textContent ? liveLogEl.textContent.split('\n') : [];
        if (lines.length === 1 && lines[0] === 'Connecting...') {
          lines.length = 0;
        }
        lines.push(formatLogLine(entry));
        const maxLines = 300;
        while (lines.length > maxLines) lines.shift();
        liveLogEl.textContent = lines.join('\n');
      }

      async function loadLogHistory() {
        try {
          const history = await api('/ui/api/logs');
          if (Array.isArray(history)) {
            liveLogEl.textContent = '';
            for (const item of history) appendLog(item);
          }
        } catch (e) {
          liveLogEl.textContent = 'Failed to load log history: ' + e.message;
        }
      }

      function connectLogStream() {
        try {
          const es = new EventSource('/ui/api/logs/stream');
          es.onopen = () => {
            if (liveLogEl && liveLogEl.textContent === 'Connecting...') {
              liveLogEl.textContent = '';
            }
          };
          es.onmessage = (evt) => {
            try {
              appendLog(JSON.parse(evt.data));
            } catch {
              // ignore
            }
          };
          es.onerror = () => {
            // Browser will auto-reconnect; show a hint if we have no content yet
            if (liveLogEl && !liveLogEl.textContent) {
              liveLogEl.textContent = 'Connecting...';
            }
          };
        } catch (e) {
          // ignore
        }
      }

      loadLogHistory();
      connectLogStream();
      refreshDevices();
    </script>
  </body>
</html>`;

/**
 * Main request handler for device API (PROXY_PORT)
 */
async function handleDeviceRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  normalizeUrl(req);

  const parsedUrl = url.parse(req.url || '', true);
  const pathname = parsedUrl.pathname || '/';
  const method = req.method || 'GET';

  const startedAt = Date.now();
  const requestSerial = resolveDeviceSerial(req) || undefined;
  res.on('finish', () => {
    uiLogPush({
      ts: startedAt,
      api: 'device',
      method,
      path: pathname,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      serial: requestSerial,
    });
  });

  console.log(`[Device API] ${method} ${pathname}`);

  if (environment.DEBUG_LOGGING) {
    createResponseLogger(req, res);
  }

  try {
    if (pathname === '/' && method === 'GET') {
      res.writeHead(302, { Location: '/ui' });
      res.end();
      return;
    }

    if (pathname === '/ui' && method === 'GET') {
      sendHtml(res, 200, UI_HTML);
      return;
    }

    if (pathname === '/ui/api/logs' && method === 'GET') {
      sendJson(res, 200, uiLogBuffer.slice(-200));
      return;
    }

    if (pathname === '/ui/api/logs/stream' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      uiLogSseClients.add(res);

      const keepAlive = setInterval(() => {
        if (res.writableEnded || res.destroyed) {
          clearInterval(keepAlive);
          uiLogSseClients.delete(res);
          return;
        }
        try {
          res.write(':keep-alive\n\n');
        } catch {
          clearInterval(keepAlive);
          uiLogSseClients.delete(res);
        }
      }, 15000);

      res.on('close', () => {
        clearInterval(keepAlive);
        uiLogSseClients.delete(res);
      });

      return;
    }

    if (pathname === '/ui/api/devices' && method === 'GET') {
      const allState = await deviceStateManager.getAllState();
      sendJson(res, 200, { devices: Object.keys(allState) });
      return;
    }

    if (pathname === '/ui/api/device' && method === 'GET') {
      const serial = (parsedUrl.query.serial as string | undefined) || '';
      if (!serial) {
        sendError(res, 400, 'Missing serial');
        return;
      }
      const deviceState = await deviceStateManager.getDeviceState(serial);
      sendJson(res, 200, { serial, state: deviceState });
      return;
    }

    if (pathname === '/ui/api/entry-key' && method === 'POST') {
      const body = await parseJsonBody(req);
      const serial = String(body?.serial || '').trim();
      if (!serial) {
        sendError(res, 400, 'Missing serial');
        return;
      }
      const key = await deviceStateManager.generateEntryKey(serial, environment.ENTRY_KEY_TTL_SECONDS);
      if (!key) {
        sendError(res, 500, 'Failed to generate entry key');
        return;
      }
      sendJson(res, 200, key);
      return;
    }

    if (pathname.startsWith('/ui/api/')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }
    }

    if (pathname === '/ui/api/command' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (environment.DEBUG_LOGGING) {
        logRequest(req, body);
      }
      const result = await handleCommand(body, deviceStateService, subscriptionManager);
      sendJson(res, 200, result);
      return;
    }

    if (pathname === '/ui/api/status' && method === 'GET') {
      if (environment.DEBUG_LOGGING) {
        logRequest(req);
      }
      handleStatus(req, res, deviceStateService);
      return;
    }

    if (pathname === '/ui/api/notify-device' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (environment.DEBUG_LOGGING) {
        logRequest(req, body);
      }
      const result = await handleNotifyDevice(body, deviceStateService, subscriptionManager);
      sendJson(res, 200, result);
      return;
    }

    if (pathname === '/nest/entry') {
      if (environment.DEBUG_LOGGING) {
        logRequest(req);
      }
      // Mark device as seen (availability heartbeat)
      const entrySerial = resolveDeviceSerial(req);
      if (entrySerial) {
        availabilityWatchdog.markSeen(entrySerial);
      }
      handleEntry(req, res);
      return;
    }

    if (pathname === '/nest/ping') {
      handlePing(req, res);
      return;
    }

    if (pathname === '/nest/upload' && method === 'POST') {
      handleUpload(req, res);
      return;
    }

    if ((pathname.startsWith('/nest/pro_info') || pathname.startsWith('/nest/pro-info')) && method === 'GET') {
      handleProInfo(req, res);
      return;
    }

    if (pathname.startsWith('/nest/weather') && method === 'GET') {
      if (environment.DEBUG_LOGGING) {
        logRequest(req);
      }
      await handleWeather(req, res, weatherService);
      return;
    }

    const serial = resolveDeviceSerial(req);

    if (!serial) {
      sendError(res, 401, 'Unauthorized: Device serial required');
      return;
    }

    if (pathname === '/nest/passphrase' && method === 'GET') {
      if (environment.DEBUG_LOGGING) {
        logRequest(req);
      }
      await handlePassphrase(req, res, serial, deviceStateManager);
      return;
    }

    if (pathname.includes('/device/') && method === 'GET') {
      if (environment.DEBUG_LOGGING) {
        logRequest(req);
      }
      await handleTransportGet(req, res, serial, deviceStateService, deviceStateManager);
      return;
    }

    if ((pathname.includes('/subscribe') || pathname === '/nest/transport') && method === 'POST' && !pathname.includes('/put')) {
      const body = await parseJsonBody(req);
      if (environment.DEBUG_LOGGING) {
        logRequest(req, body);
      }
      // Note: Device availability is tracked via active subscriptions in SubscriptionManager
      await handleTransportSubscribe(req, res, serial, body, deviceStateService, subscriptionManager, deviceStateManager);
      return;
    }

    if (pathname.includes('/put') && method === 'POST') {
      console.log(`[${new Date().toISOString()}] [Device API] Received PUT from ${serial}`);
      const body = await parseJsonBody(req);
      if (environment.DEBUG_LOGGING) {
        logRequest(req, body);
      }
      // Mark device as seen (availability heartbeat)
      availabilityWatchdog.markSeen(serial);
      await handlePut(req, res, serial, body, deviceStateService, subscriptionManager, deviceStateManager);
      return;
    }

    sendError(res, 404, 'Not Found');
  } catch (error) {
    console.error('[Device API] Error:', error);
    sendError(res, 500, error instanceof Error ? error.message : 'Internal Server Error');
  }
}


/**
 * Create HTTPS server if certificates are available
 */
function createHttpsServer(): https.Server | null {
  if (!environment.CERT_DIR) {
    return null;
  }

  try {
    const certPath = path.join(environment.CERT_DIR, 'cert.pem');
    const keyPath = path.join(environment.CERT_DIR, 'key.pem');

    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
      console.warn(`[HTTPS] Certificates not found in ${environment.CERT_DIR}`);
      return null;
    }

    const options = {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
      rejectUnauthorized: false, // Required for Nest devices
    };

    const server = https.createServer(options, handleDeviceRequest);
    console.log('[HTTPS] Server created with TLS certificates');
    return server;
  } catch (error) {
    console.error('[HTTPS] Failed to create HTTPS server:', error);
    return null;
  }
}

/**
 * Start servers
 */
async function startServers(): Promise<void> {
  const httpsServer = createHttpsServer();
  if (httpsServer) {
    httpsServer.on('error', err => {
      console.error(`[Device API] Failed to listen on port ${environment.PROXY_PORT}:`, err);
      console.error('[Device API] If this is EACCES or EADDRINUSE, run as admin or change PROXY_PORT.');
    });
    httpsServer.listen(environment.PROXY_PORT, () => {
      console.log(`[Device API] HTTPS server listening on port ${environment.PROXY_PORT}`);
    });
  } else {
    const httpServer = http.createServer(handleDeviceRequest);
    httpServer.on('error', err => {
      console.error(`[Device API] Failed to listen on port ${environment.PROXY_PORT}:`, err);
      console.error('[Device API] If this is EACCES or EADDRINUSE, run as admin or change PROXY_PORT.');
    });
    httpServer.listen(environment.PROXY_PORT, () => {
      console.log(`[Device API] HTTP server listening on port ${environment.PROXY_PORT}`);
    });
  }

  console.log('[Control API] Control endpoints consolidated on port 80 under /ui/api/*');

  console.log('[Integrations] Loading enabled integrations...');
  await integrationManager.initialize(deviceStateManager, deviceStateService, subscriptionManager);

  deviceStateService.setIntegrationManager(integrationManager);

  // Start availability watchdog and connect it to integration manager
  console.log('[DeviceAvailability] Starting availability watchdog...');
  availabilityWatchdog.setAvailabilityChangeHandler((serial, isAvailable) => {
    integrationManager.notifyAvailabilityChange(serial, isAvailable);
  });
  availabilityWatchdog.start(subscriptionManager);

  console.log(`[Integrations] ${integrationManager.getActiveCount()} integration(s) loaded`);
}

/**
 * Graceful shutdown
 */
function setupGracefulShutdown(): void {
  const shutdown = async () => {
    console.log('\n[Shutdown] Received shutdown signal');
    console.log('[Shutdown] Stopping availability watchdog...');
    availabilityWatchdog.stop();
    console.log('[Shutdown] Closing integrations...');
    await integrationManager.shutdown();
    console.log('[Shutdown] Closing subscriptions...');
    await subscriptionManager.shutdown();
    console.log('[Shutdown] Complete');
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

/**
 * Verify device setup
 */
async function verifyDeviceSetup(): Promise<void> {
  console.log('[DeviceInitialization] Verify Nest device(s) setup.')
  
  if (environment.NEST_DEVICES) {
    const server_origin = environment.API_ORIGIN + '/entry';
    for (const device of environment.NEST_DEVICES) {
      console.log(`[DeviceInitialization] Checking device (${device.deviceId}).`);
      const serial = await deviceStateManager.getDeviceByID(device.deviceId);
      if (!serial) {
        console.log(`[DeviceInitialization] Getting device (${device.deviceId}) endpoint url.`);
        try {
          const device_endpoint = await deviceInitialization.getDeviceEndpoint(device);
          if (device_endpoint) {
            if (device_endpoint == server_origin) {
              console.log(`[DeviceInitialization] Device (${device.deviceId}) already setup.`);
            } else {
              console.log(`[DeviceInitialization] Device (${device.deviceId}) not setup to use this server. Updating...`);
              await deviceInitialization.updateDeviceEndpoint(device, environment.API_ORIGIN);
            }
          }
        } catch (error) {
          console.error(`[DeviceInitialization] Failed to validate device (${device.deviceId}).`)
        }
      } else {
        console.log(`[DeviceInitialization] Device (${device.deviceId}) exists in database. No setup needed.`);
      }
    }
  } else {
    console.log('[DeviceInitialization] No devices setup for initialization. Skip.');
  }
}

/**
 * Verify MQTT Setup
 */
async function mqttSetup(): Promise<void> {
  console.log('[MQTTInitialization] Checking for MQTT setup.');

  // Update enabled/disabled status.
  await deviceStateManager.updateMqttStatus(environment.MQTT_ENABLED);
  // If enabled create/update the integration
  if (environment.MQTT_ENABLED && environment.NEST_DEVICES) {
    const mqtt_config = {
      brokerUrl: `mqtt://${environment.MQTT_SERVER_IP}:${environment.MQTT_SERVER_PORT}`,
      clientId: `nolongerevil-hass`,
      topicPrefix: `${environment.MQTT_TOPIC_PREFIX}`,
      discoveryPrefix: `${environment.MQTT_DISCOVERY_PREFIX}`,
      username: `${environment.MQTT_USERNAME}`,
      password: `${environment.MQTT_PASSWORD}`,
      homeAssistantDiscovery: environment.MQTT_HA_DISCOVERY
    };
    const exist_mqtt = await deviceStateManager.getMqttIntegration(environment.MQTT_DEFAULT_ID);
    if (!exist_mqtt) {
      // Setup MQTT Integration for Devices

      // Create deviceOwner account if needed.
      for (const device of environment.NEST_DEVICES) {
        let createDeviceOwner = false;
        const deviceOwner = await deviceStateManager.getDeviceOwner(device.deviceId);
        if (deviceOwner) {
          // Check if MQTT default id
          if (deviceOwner.userId != environment.MQTT_DEFAULT_ID) {
            createDeviceOwner = true;
          }
        } else {
          createDeviceOwner = true;
        }

        if (createDeviceOwner) {
          console.log(`[MQTTInitialization] Create device owner (${environment.MQTT_DEFAULT_ID})`);
          await deviceStateManager.insertDeviceOwner(environment.MQTT_DEFAULT_ID, device.deviceId);
        }
      }

      // Create integration.
      console.log(`[MQTTIntegration] Create MQTT integration.`);
      await deviceStateManager.insertMqttIntegration(mqtt_config);
    } else {
      // MQTT integration already setup. Update from environment.
      console.log(`[MQTTIntegration] Setup exists. Update from environment.`);
      await deviceStateManager.updateMqttConfig(mqtt_config);
    }
  }
}

console.log('='.repeat(60));
console.log('NoLongerEvil Thermostat API Server (TypeScript)');
console.log('='.repeat(60));

(async () => {
  await verifyDeviceSetup();
  await mqttSetup();

  await startServers();
  setupGracefulShutdown();

  console.log('\n[Server] Initialization complete');
  console.log('[Server] Press Ctrl+C to stop\n');
})();
