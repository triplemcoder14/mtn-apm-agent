'use strict';

const os = require('os');
const { spawnSync } = require('child_process');

/**
 * *Synchronously* detect the current hostname, preferring the FQDN.
 * This is sent to APM server as `metadata.system.detected_hostname`
 * and is intended to fit the ECS `host.name` value
 *
 * @returns {String}
 */
function detectHostname() {
  let hostname = null;
  let out;
  const fallback = os.hostname();

  switch (os.platform()) {
    case 'win32':
      
      out = spawnSync(
        'powershell.exe',
        [
          '-NoLogo',
          '-NonInteractive',
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          '[System.Net.Dns]::GetHostEntry($env:computerName).HostName',
        ],
        { encoding: 'utf8', shell: true, timeout: 2000 },
      );
      if (!out.error) {
        hostname = out.stdout.trim();
        break;
      }

      out = spawnSync('hostname.exe', {
        encoding: 'utf8',
        shell: true,
        timeout: 2000,
      });
      if (!out.error) {
        hostname = out.stdout.trim();
        break;
      }

      if ('COMPUTERNAME' in process.env) {
        hostname = process.env['COMPUTERNAME'].trim(); // eslint-disable-line dot-notation
      }
      break;

    default:
      out = spawnSync('/bin/hostname', ['-f'], {
        encoding: 'utf8',
        shell: false,
        timeout: 500,
      });
      if (!out.error) {
        hostname = out.stdout.trim();
      }
    
      break;
  }

  if (!hostname) {
    hostname = fallback;
  }
  hostname = hostname.trim().toLowerCase();
  return hostname;
}

module.exports = {
  detectHostname,
};

// ---- main

if (require.main === module) {
  console.log(detectHostname());
}
