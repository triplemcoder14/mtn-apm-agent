const { chmod } = require("node:fs/promises");
const path = require("node:path");
const { generateReleaseInfo } = require("./generateReleaseInfo");
const { generateDebianChangelog } = require("./generateDebianChangelog");

async function runReleaseTasks() {
  try {
    console.log(" Starting release preparation...");

    const projectRoot = path.join(__dirname, "..");

    // Generate release metadata
    const { releaseInfo } = await generateReleaseInfo(projectRoot);

    // Generate Debian changelog (Linux packaging)
    console.log(" Generating Debian changelog...");
    await generateDebianChangelog(projectRoot);

    console.log(" Release preparation completed");
    console.log(`   Release Name: ${releaseInfo.releaseName}`);
    console.log(`   Release Date: ${releaseInfo.releaseDate}`);

    
    //const executablePath = path.join(projectRoot, "dist", "sdk");

    try {
      await chmod(executablePath, 0o755);
      console.log(`Executable permissions set on ${executablePath}`);
    } catch {
      console.log("ℹ No executable found to chmod (skipping)");
    }

  } catch (error) {
    console.error(" Release task failed:", error);
    process.exit(1);
  }
}

// Run directly
if (require.main === module) {
  runReleaseTasks();
}

module.exports = {
  runReleaseTasks,
};
