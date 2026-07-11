const { spawn } = require('child_process');
const path = require('path');

console.log('Starting Vite development server...');

// 1. Start the Vite dev server
const vite = spawn('npx', ['vite'], {
  shell: true,
  env: { ...process.env }
});

let electronStarted = false;

vite.stdout.on('data', (data) => {
  const output = data.toString();
  process.stdout.write(output);

  // Match the local development URL (e.g., http://localhost:5173)
  const match = output.match(/http:\/\/localhost:\d+/);
  if (match && !electronStarted) {
    electronStarted = true;
    const devServerUrl = match[0];
    
    console.log(`\nDetected Vite server at ${devServerUrl}. Compiling main & preload...`);
    
    // 2. Compile main and preload typescript files
    const compileMain = spawn('npx', ['tsc', '-p', 'tsconfig.main.json'], { shell: true });
    
    compileMain.on('close', (mainCode) => {
      if (mainCode !== 0) {
        console.error('TypeScript compilation for main process failed.');
        return;
      }
      
      const compilePreload = spawn('npx', ['tsc', '-p', 'tsconfig.preload.json'], { shell: true });
      
      compilePreload.on('close', (preloadCode) => {
        if (preloadCode !== 0) {
          console.error('TypeScript compilation for preload script failed.');
          return;
        }
        
        console.log('Compilation successful. Launching Electron...');
        
        // 3. Spawn Electron with VITE_DEV_SERVER_URL environment variable
        const electronApp = spawn('npx', ['electron', '.'], {
          shell: true,
          env: {
            ...process.env,
            VITE_DEV_SERVER_URL: devServerUrl
          },
          stdio: 'inherit'
        });

        electronApp.on('close', () => {
          console.log('Electron application closed. Exiting dev server...');
          vite.kill();
          process.exit(0);
        });
      });
    });
  }
});

vite.stderr.on('data', (data) => {
  process.stderr.write(data.toString());
});
