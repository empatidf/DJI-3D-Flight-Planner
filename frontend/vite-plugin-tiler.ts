/**
 * Vite Plugin for GeoTIFF Tiling
 * Handles file uploads and runs Python tiling asynchronously
 */

import type { Plugin } from 'vite';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function tilerPlugin(): Plugin {
  return {
    name: 'geotiff-tiler',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        // Handle tile upload and generation
        if (req.url === '/api/tile' && req.method === 'POST') {
          try {
            // Parse multipart form data
            const chunks: Buffer[] = [];
            req.on('data', (chunk) => chunks.push(chunk));
            req.on('end', async () => {
              try {
                const buffer = Buffer.concat(chunks);
                
                // Simple multipart parser (for production, use a proper library)
                const boundary = req.headers['content-type']?.split('boundary=')[1];
                if (!boundary) {
                  res.writeHead(400, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'No boundary found' }));
                  return;
                }
                
                const parts = buffer.toString('binary').split(`--${boundary}`);
                let fileBuffer: Buffer | null = null;
                let layerId = '';
                let filename = '';
                
                for (const part of parts) {
                  if (part.includes('name="file"')) {
                    const filenameMatch = part.match(/filename="([^"]+)"/);
                    if (filenameMatch) {
                      filename = filenameMatch[1];
                    }
                    const dataStart = part.indexOf('\r\n\r\n') + 4;
                    const dataEnd = part.lastIndexOf('\r\n');
                    if (dataStart > 3 && dataEnd > dataStart) {
                      const binaryData = part.substring(dataStart, dataEnd);
                      fileBuffer = Buffer.from(binaryData, 'binary');
                    }
                  } else if (part.includes('name="layerId"')) {
                    const match = part.match(/\r\n\r\n([^\r\n]+)/);
                    if (match) layerId = match[1];
                  } else if (part.includes('name="layerType"')) {
                    // layerType extracted but not currently used in Python script
                    // const match = part.match(/\r\n\r\n([^\r\n]+)/);
                    // if (match) layerType = match[1];
                  }
                }
                
                if (!fileBuffer || !layerId) {
                  res.writeHead(400, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'Missing file or layerId' }));
                  return;
                }
                
                // Save file to temp directory
                const tempDir = path.join(__dirname, 'temp');
                await fs.mkdir(tempDir, { recursive: true });
                const tempFile = path.join(tempDir, `${layerId}_${filename}`);
                await fs.writeFile(tempFile, fileBuffer);
                
                // Ensure output directory exists
                const outputDir = path.join(__dirname, 'public', 'tiles', layerId);
                await fs.mkdir(outputDir, { recursive: true });
                
                // Run Python tiling
                const backendDir = path.join(__dirname, '..', 'backend');
                const pythonScript = path.join(backendDir, 'tile_cli.py');
                
                console.log(`Starting tile generation: ${tempFile} -> ${outputDir}`);
                const pythonProcess = spawn('py', [pythonScript, tempFile, outputDir]);
                
                let output = '';
                let errorOutput = '';
                
                pythonProcess.stdout.on('data', (data) => {
                  const text = data.toString();
                  output += text;
                  console.log('[Python]', text);
                });
                
                pythonProcess.stderr.on('data', (data) => {
                  const text = data.toString();
                  errorOutput += text;
                  console.error('[Python ERROR]', text);
                });
                
                pythonProcess.on('close', async (code) => {
                  // Clean up temp file
                  try {
                    await fs.unlink(tempFile);
                  } catch {}
                  
                  if (code === 0) {
                    try {
                      const jsonMatch = output.match(/RESULT_JSON:(\{[\s\S]*\})/);
                      if (jsonMatch) {
                        const result = JSON.parse(jsonMatch[1]);
                        console.log('Tiling completed successfully:', result);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(result));
                      } else {
                        console.error('No result found in output:', output);
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'No result found', output, stderr: errorOutput }));
                      }
                    } catch (error) {
                      console.error('Failed to parse result:', error);
                      res.writeHead(500, { 'Content-Type': 'application/json' });
                      res.end(JSON.stringify({ error: 'Failed to parse result', details: String(error), output }));
                    }
                  } else {
                    console.error('Python tiling failed with code:', code);
                    console.error('stderr:', errorOutput);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Python tiling failed', code, stderr: errorOutput, stdout: output }));
                  }
                });
              } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: String(error) }));
              }
            });
          } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(error) }));
          }
          return;
        }
        
        // Handle tile deletion
        if (req.url?.startsWith('/api/tile/') && req.method === 'DELETE') {
          const layerId = req.url.split('/api/tile/')[1];
          const tileDir = path.join(__dirname, 'public', 'tiles', layerId);
          
          try {
            await fs.rm(tileDir, { recursive: true, force: true });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(error) }));
          }
          return;
        }
        
        next();
      });
    },
  };
}
