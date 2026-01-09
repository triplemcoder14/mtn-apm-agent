#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const xml2js = require("xml2js");

async function generateReleaseInfo(projectRoot = null) {
  const root = projectRoot || path.join(__dirname, "..");

  // Load package.json
  const pkgPath = path.join(root, "package.json");
  if (!fs.existsSync(pkgPath)) {
    throw new Error("package.json not found.");
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

  // Load package-lock.json
  const lockPath = path.join(root, "package-lock.json");
  if (!fs.existsSync(lockPath)) {
    throw new Error(
      'package-lock.json not found. Run "npm install" to generate it.'
    );
  }
  const pkgLock = JSON.parse(fs.readFileSync(lockPath, "utf8"));

  // Ensure version consistency
  if (pkg.version !== pkgLock.version) {
    throw new Error(
      `Version mismatch: package.json (${pkg.version}) vs package-lock.json (${pkgLock.version})`
    );
  }

  
  const appdataPath = path.join(
    root,
    "com.github.triplemcoder14.mtn-telemetry-sdk.appdata.xml"
  );
  if (!fs.existsSync(appdataPath)) {
    throw new Error("AppStream XML file not found.");
  }

  const xmlContent = fs.readFileSync(appdataPath, "utf8");
  const parser = new xml2js.Parser();
  const parsed = await parser.parseStringPromise(xmlContent);

  const releases = parsed?.component?.releases?.[0]?.release;
  if (!releases) {
    throw new Error("No releases found in AppStream XML.");
  }

  // find release matching current version
  const release = releases.find(r => r.$.version === pkg.version);
  if (!release) {
    throw new Error(`No release entry found for version ${pkg.version}.`);
  }

  const releaseDate = release.$.date;
  let releaseNotes = "";

  const desc = release.description?.[0];
  if (desc?.ul?.[0]?.li) {
    releaseNotes = desc.ul[0].li
      .map(li => `• ${typeof li === "string" ? li : li._ || ""}`)
      .join("\n");
  } else if (typeof desc === "string") {
    releaseNotes = desc;
  } else if (desc?._) {
    releaseNotes = desc._;
  }

  if (!releaseNotes.trim()) {
    throw new Error("Release notes are empty.");
  }

  const releaseInfo = {
    version: pkg.version,
    releaseDate,
    releaseNotes,
  };

  return {
    releaseInfo,
    versionInfo: {
      packageJson: pkg.version,
      packageLock: pkgLock.version,
      appdata: pkg.version,
    },
  };
}

/**
 * CLI execution
 */
if (require.main === module) {
  (async () => {
    try {
      const { releaseInfo, versionInfo } = await generateReleaseInfo();

      console.log(" Version consistency check passed:");
      console.log(versionInfo);
      console.log("\n Generated release metadata:\n");
      console.log(JSON.stringify(releaseInfo, null, 2));

      const outputPath = path.join(__dirname, "..", "release-info.json");
      fs.writeFileSync(outputPath, JSON.stringify(releaseInfo, null, 2));

      console.log(`\n Saved to ${outputPath}`);
    } catch (err) {
      console.error(" Error:", err.message);
      process.exit(1);
    }
  })();
}

module.exports = { generateReleaseInfo };
