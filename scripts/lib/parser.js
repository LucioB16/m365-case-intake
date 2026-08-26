const fs = require('fs');
const path = require('path');
const os = require('os');

function parsePayload(markdownFile, onedriveFolderConfig) {
    if (!fs.existsSync(markdownFile)) {
        console.error(`Error: Cannot find response log at ${markdownFile}`);
        process.exit(1);
    }

    const content = fs.readFileSync(markdownFile, 'utf8');
    
    // Resolve absolute path to the configured OneDrive folder
    // E.g., if config says "Client Cases", we look for "C:\Users\Username\OneDrive - Argano LLC\Client Cases"
    // Or we assume onedriveFolderConfig is the absolute path if specified, or we resolve it.
    let onedriveRoot = '';
    const possibleRoots = [
        path.join(os.homedir(), 'OneDrive - Argano LLC', onedriveFolderConfig),
        path.join(os.homedir(), 'OneDrive', onedriveFolderConfig),
        onedriveFolderConfig // fallback if absolute
    ];

    for (const r of possibleRoots) {
        if (fs.existsSync(path.dirname(r))) {
            onedriveRoot = r;
            break;
        }
    }

    if (!fs.existsSync(onedriveRoot)) {
        fs.mkdirSync(onedriveRoot, { recursive: true });
    }

    const regex = /(?:```markdown\s*\n)?\*\*FilePath:\*\*\s*`([^`]+)`\s*(?:```\w*\s*\n)?(.*?)(?:```)/gs;
    let match;
    let filesParsed = 0;

    // Alternative simpler regex based on Copilot's typical output:
    // "Client Cases/Account/Case/agents.md\n```markdown\n(content)\n```"
    const blocksRegex = /([a-zA-Z0-9_\-\.\/ ]+)\s*\n\s*```(?:markdown)?\s*\n(.*?)```/gs;

    console.log(`\nParsing markdown payload into ${onedriveRoot}...`);

    while ((match = blocksRegex.exec(content)) !== null) {
        const relativePath = match[1].trim();
        const fileContent = match[2].trim() + '\n';

        // Ignore generic or conversational captures
        if (!relativePath.includes('/') && !relativePath.endsWith('.json')) continue;
        // Strip the root folder name from relative path if Copilot included it
        let cleanRelPath = relativePath;
        if (cleanRelPath.startsWith(onedriveFolderConfig + '/')) {
            cleanRelPath = cleanRelPath.substring(onedriveFolderConfig.length + 1);
        }

        const destPath = path.join(onedriveRoot, cleanRelPath);
        const destDir = path.dirname(destPath);
        
        if (!fs.existsSync(destDir)) {
            console.log(`Creating directory: ${destDir}`);
            fs.mkdirSync(destDir, { recursive: true });
        }

        console.log(`Writing to: ${destPath}`);
        fs.writeFileSync(destPath, fileContent, 'utf8');
        filesParsed++;
    }

    if (filesParsed === 0) {
        console.log("No file payload blocks found. (Maybe no cases matched, or Copilot formatting was off).");
    } else {
        console.log(`Successfully wrote ${filesParsed} files to OneDrive.`);
    }
}

module.exports = { parsePayload };
