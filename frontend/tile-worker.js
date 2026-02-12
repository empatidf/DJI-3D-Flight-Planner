#!/usr/bin/env node
/**
 * Node.js script to run Python GeoTIFF tiling asynchronously
 * Called from frontend, generates tiles to public/tiles/ directory
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0]; // 'tile' or 'delete'

if (command === 'tile') {
  const inputFile = args[1];
  const layerId = args[2];
  const layerType = args[3] || 'rgb';

  if (!inputFile || !layerId) {
    console.error('Usage: node tile-worker.js tile <inputFile> <layerId> [layerType]');
    process.exit(1);
  }

  const outputDir = path.join(__dirname, 'public', 'tiles', layerId);
  const pythonScript = path.join(__dirname, '..', 'backend', 'imagery_tiler.py');

  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  // Run Python tiling script
  const pythonProcess = spawn('py', [
    '-c',
    `
import sys
sys.path.insert(0, '${path.dirname(pythonScript).replace(/\\/g, '\\\\')}')
from imagery_tiler import generate_tiles
result = generate_tiles('${inputFile.replace(/\\/g, '\\\\')}', '${outputDir.replace(/\\/g, '\\\\')}')
import json
print(json.dumps(result))
`
  ]);

  let output = '';
  let errorOutput = '';

  pythonProcess.stdout.on('data', (data) => {
    output += data.toString();
    process.stdout.write(data);
  });

  pythonProcess.stderr.on('data', (data) => {
    errorOutput += data.toString();
    process.stderr.write(data);
  });

  pythonProcess.on('close', (code) => {
    if (code === 0) {
      try {
        // Extract JSON from output
        const jsonMatch = output.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          console.log('\n=== TILING COMPLETE ===');
          console.log(JSON.stringify(result, null, 2));
          process.exit(0);
        } else {
          console.error('No JSON result found in output');
          process.exit(1);
        }
      } catch (error) {
        console.error('Failed to parse result:', error);
        process.exit(1);
      }
    } else {
      console.error(`Python process exited with code ${code}`);
      console.error(errorOutput);
      process.exit(code);
    }
  });

} else if (command === 'delete') {
  const layerId = args[1];

  if (!layerId) {
    console.error('Usage: node tile-worker.js delete <layerId>');
    process.exit(1);
  }

  const tileDir = path.join(__dirname, 'public', 'tiles', layerId);

  // Delete tile directory
  if (fs.existsSync(tileDir)) {
    fs.rmSync(tileDir, { recursive: true, force: true });
    console.log(`Deleted tiles for layer: ${layerId}`);
    process.exit(0);
  } else {
    console.log(`Tile directory not found: ${tileDir}`);
    process.exit(0);
  }

} else {
  console.error('Unknown command. Use: tile or delete');
  process.exit(1);
}
