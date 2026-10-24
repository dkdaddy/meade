import { execFile } from 'node:child_process';
import geomagnetism from 'geomagnetism';
import { parseDegrees } from './angles.js';

const SCRIPT = `
Add-Type -AssemblyName System.Device
$w = New-Object System.Device.Location.GeoCoordinateWatcher([System.Device.Location.GeoPositionAccuracy]::High)
$null = $w.TryStart($false, [TimeSpan]::FromSeconds(10))
$deadline = (Get-Date).AddSeconds(25)
while ($w.Position.Location.IsUnknown -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
$l = $w.Position.Location
if ($l.IsUnknown) { exit 2 }
[pscustomobject]@{ latitude = $l.Latitude; longitude = $l.Longitude; accuracy = $l.HorizontalAccuracy } | ConvertTo-Json -Compress
`;

// Position from Windows location services. Longitude is positive east.
export function getPcLocation() {
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { timeout: 45000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          reject(new Error('Windows location is unavailable (enable Settings > Privacy > Location) - pass --lat and --lon instead.'));
          return;
        }
        const { latitude, longitude, accuracy } = JSON.parse(stdout);
        resolve({ latitude, longitude, accuracyMeters: accuracy });
      },
    );
  });
}

// Location from --lat/--lon if given, otherwise from the PC.
export async function resolveLocation(values) {
  if (values.lat !== undefined || values.lon !== undefined) {
    if (values.lat === undefined || values.lon === undefined) throw new Error('Pass both --lat and --lon.');
    return { latitude: parseDegrees(values.lat), longitude: parseDegrees(values.lon), source: 'command line' };
  }
  const loc = await getPcLocation();
  return { ...loc, source: 'Windows location services' };
}

// Magnetic declination in degrees, positive east (World Magnetic Model).
export function magneticDeclination(latitude, longitude, date = new Date()) {
  return geomagnetism.model(date).point([latitude, longitude]).decl;
}
