const fs = require('fs');
const path = require('path');

// Define paths based on your monorepo structure
const rootDir = path.join(__dirname, '..');
const apiDir = path.join(rootDir, 'apps/api');
const logsDir = path.join(rootDir, 'logs');

// Ensure logs directory exists safely
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

let totalFiles = 0;
let totalLines = 0;

// Function to safely scan only your JS/TS files, ignoring node_modules
function scanDirectory(directory) {
    if (!fs.existsSync(directory)) return;
    
    const files = fs.readdirSync(directory);
    for (const file of files) {
        const fullPath = path.join(directory, file);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
            if (file !== 'node_modules' && file !== 'dist') {
                scanDirectory(fullPath);
            }
        } else if (file.endsWith('.js') || file.endsWith('.ts')) {
            totalFiles++;
            const content = fs.readFileSync(fullPath, 'utf-8');
            totalLines += content.split('\n').length;
        }
    }
}

// Run the scan
scanDirectory(apiDir);

// 1. Write the PROJECT_METRICS.md file
const metricsContent = `# Project Metrics\n\n- **Total Monorepo Files (API):** ${totalFiles}\n- **Total Lines of Code:** ${totalLines}\n- **Last Automated Scan:** ${new Date().toISOString()}\n`;
fs.writeFileSync(path.join(rootDir, 'PROJECT_METRICS.md'), metricsContent);

// 2. Append to the automation log
const logEntry = `Automated run at ${new Date().toISOString()} - Scanned ${totalFiles} files.\n`;
fs.appendFileSync(path.join(logsDir, 'automation.log'), logEntry);

// 3. Update the README.md safely
const readmePath = path.join(rootDir, 'README.md');
if (fs.existsSync(readmePath)) {
    let readmeContent = fs.readFileSync(readmePath, 'utf-8');
    const metricsHeader = '## Automated Metrics';
    const timestampText = `Last scanned on: ${new Date().toUTCString()}`;
    
    if (readmeContent.includes(metricsHeader)) {
        // Find the header and replace the line right below it
        const regex = new RegExp(`(${metricsHeader}\\s*\\n)(.*)`, 'g');
        readmeContent = readmeContent.replace(regex, `$1${timestampText}`);
    } else {
        // Append section to the very bottom if it doesn't exist
        readmeContent += `\n\n${metricsHeader}\n${timestampText}\n`;
    }
    fs.writeFileSync(readmePath, readmeContent);
}