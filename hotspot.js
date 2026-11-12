// Windows Mobile Hotspot control for "No Wi-Fi" mode.
// Drives the WinRT NetworkOperatorTetheringManager through PowerShell. Windows only; elsewhere every call
// reports `supported: false`. SSID and password are generated here, never taken from user input.
const { execFile } = require('child_process');
const crypto = require('crypto');

const isWin = process.platform === 'win32';

const PRELUDE = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType = WindowsRuntime]
[void][Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager, Windows.Networking.NetworkOperators, ContentType = WindowsRuntime]
[void][Windows.Networking.NetworkOperators.NetworkOperatorTetheringAccessPointConfiguration, Windows.Networking.NetworkOperators, ContentType = WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function AwaitOp($op, $type) { $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
function AwaitAction($a) { $t = [System.WindowsRuntimeSystemExtensions]::AsTask($a); $t.Wait(-1) | Out-Null }
function GetProfile {
  $p = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()
  if (-not $p) { $p = [Windows.Networking.Connectivity.NetworkInformation]::GetConnectionProfiles() | Select-Object -First 1 }
  if (-not $p) { throw 'NO_CONNECTION' }
  $p
}
function GetManager { [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::CreateFromConnectionProfile((GetProfile)) }
`;
const OPRESULT = '[Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult]';
const wrap = body => `${PRELUDE}\ntry {\n${body}\n} catch { @{ error = $_.Exception.Message } | ConvertTo-Json -Compress }`;

function runPS(script, timeout = 45000) {
  return new Promise(resolve => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
        const text = String(stdout || '').trim().split(/\r?\n/).pop();
        try { return resolve(JSON.parse(text)); } catch {}
        resolve({ error: (stderr || (err && err.message) || 'No response from Windows').toString().trim().slice(0, 300) });
      });
  });
}

const unsupported = reason => ({ supported: false, state: 'Off', reason });
let cache = { at: 0, value: null };

async function status() {
  if (!isWin) return unsupported('Windows only');
  if (cache.value && Date.now() - cache.at < 2000) return cache.value;
  const r = await runPS(wrap(`
$p = GetProfile
$m = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::CreateFromConnectionProfile($p)
$cap = [string][Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::GetTetheringCapabilityFromConnectionProfile($p)
$state = [string]$m.TetheringOperationalState
$cfg = $m.GetCurrentAccessPointConfiguration()
@{ capability = $cap; state = $state; ssid = $cfg.Ssid; passphrase = $cfg.Passphrase; clients = $m.ClientCount } | ConvertTo-Json -Compress`));
  let value;
  if (r.error) {
    value = { supported: r.error !== 'NO_CONNECTION' ? false : 'unknown', state: 'Off', error: r.error === 'NO_CONNECTION'
      ? 'Windows needs one network connection to share. Connect to any Wi-Fi or Ethernet once, or use the iPhone hotspot.' : r.error };
  } else {
    value = { supported: r.capability === 'Enabled', capability: r.capability, state: r.state, ssid: r.ssid, passphrase: r.passphrase, clients: r.clients };
  }
  cache = { at: Date.now(), value };
  return value;
}

const ALPHA = 'abcdefghijkmnpqrstuvwxyz23456789';
const rand = n => Array.from(crypto.randomBytes(n), b => ALPHA[b % ALPHA.length]).join('');

async function start() {
  if (!isWin) return unsupported('Windows only');
  // Reuse the hotspot name and password already saved in Windows (no settings are changed).
  // Only when none exist do we create fresh ones.
  const ssid = 'UFTI-' + rand(4).toUpperCase();
  const pass = rand(10);
  const r = await runPS(wrap(`
$m = GetManager
$cfg = $m.GetCurrentAccessPointConfiguration()
if (-not $cfg.Ssid -or -not $cfg.Passphrase -or $cfg.Passphrase.Length -lt 8) {
  $cfg = New-Object Windows.Networking.NetworkOperators.NetworkOperatorTetheringAccessPointConfiguration
  $cfg.Ssid = '${ssid}'
  $cfg.Passphrase = '${pass}'
  AwaitAction ($m.ConfigureAccessPointAsync($cfg))
}
$res = AwaitOp ($m.StartTetheringAsync()) (${OPRESULT})
@{ ok = ([string]$res.Status -eq 'Success'); status = [string]$res.Status; message = [string]$res.AdditionalErrorMessage; ssid = $cfg.Ssid; passphrase = $cfg.Passphrase } | ConvertTo-Json -Compress`), 60000);
  cache = { at: 0, value: null };
  if (r.error) return { ok: false, error: r.error === 'NO_CONNECTION'
    ? 'Windows needs one network connection to share. Connect to any Wi-Fi or Ethernet once, or use the iPhone hotspot.' : r.error };
  return r.ok ? { ok: true, ssid: r.ssid, passphrase: r.passphrase } : { ok: false, error: r.message || r.status };
}

async function stop() {
  if (!isWin) return unsupported('Windows only');
  const r = await runPS(wrap(`
$m = GetManager
$res = AwaitOp ($m.StopTetheringAsync()) (${OPRESULT})
@{ ok = ([string]$res.Status -eq 'Success'); status = [string]$res.Status } | ConvertTo-Json -Compress`));
  cache = { at: 0, value: null };
  return r.error ? { ok: false, error: r.error } : { ok: !!r.ok };
}

// Firewall rule for the app's port on every network type (hotspot networks are often classed differently).
function firewallRuleExists() {
  return new Promise(resolve => {
    if (!isWin) return resolve(false);
    execFile('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=UFTI'], { windowsHide: true }, err => resolve(!err));
  });
}
async function allowFirewall(port) {
  if (!isWin) return { ok: false, error: 'Windows only' };
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return { ok: false, error: 'bad port' };
  if (await firewallRuleExists()) return { ok: true, already: true };
  // Triggers the Windows admin (UAC) prompt; the user has to approve it.
  const script = `Start-Process netsh -ArgumentList 'advfirewall firewall add rule name=UFTI dir=in action=allow protocol=TCP localport=${p} profile=any' -Verb RunAs -Wait -WindowStyle Hidden`;
  await new Promise(r => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 90000 }, () => r()));
  return { ok: await firewallRuleExists() };
}

module.exports = { status, start, stop, allowFirewall, firewallRuleExists };
