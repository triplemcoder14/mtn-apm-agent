MTN APM Node.js Agent
 
This is the MTN-official Node.js application performance monitoring (APM)
agent. It keeps the battle-tested auto-instrumentation logic from the upstream
Otel APM agent but packages it for MTN engineers as a simple drop-in SDK.
Install the package, provide your MTN observability endpoint, and your Node.js
application is automatically instrumented without manual code changes.
 
The agent captures errors, traces, and performance metrics and forwards them to
your MTN Observability platform so you can monitor services, create alerts, and
quickly identify root causes. MTN engineers can reach the internal SRE team for questions or feedback.
 
 
## Installation
 
```
npm install --save mtn-apm-agent
```
 
## Getting started
 
You will need an MTN Observability endpoint that accepts APM traffic. Obtain the
APM **`serverUrl`** from the SRE team before starting.
 
Getting started typically looks like this:
 
1. Install the APM agent package as a dependency:
 
    ```
    npm install --save mtn-apm-agent
    ```
 
2. Initialize the APM agent before any other imports
   Create a file called init.apm.ts:
 
    ```js
    // init.apm.ts
    const apm = require('mtn-apm-agent');
    
    apm.start({
      serviceName: 'your-service-name',
      environment: 'your-deployment-environment',
      serverUrl: 'http://localhost:8200',
      captureBody: 'all',
      opentelemetryBridgeEnabled: true,
    });
    
    export = apm;
    ```
    
3: Import it FIRST in your application entry point

```js
// main.ts
import './init.apm';
import { NestFactory } from '@nestjs/core';
```
    
 
### Loading the agent early (important)

The MTN APM agent must be started before any other application code so that
automatic instrumentation works correctly.

#### CommonJS applications
Start the agent at the very top of your main entry file:

```js
require('mtn-apm-agent').start({...});
```

TypeScript / ESM applications (recommended)

To avoid issues caused by transpilation or bundling, preload the agent using

```bash
node -r mtn-apm-agent/start dist/main.js
```


 
<br>Made with ♥️ by MTN SRE Team.
