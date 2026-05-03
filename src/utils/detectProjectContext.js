import fs from "node:fs";
import path from "node:path";
import { buildConstraints, buildResearchDirective } from "./projectDirectives.js";

/**
 * Returns true if rootDir appears to be a Swift / Xcode project.
 * Detection: *.xcodeproj directory OR *.xcworkspace directory OR Package.swift file.
 */
export function isSwiftProject(rootDir) {
  try {
    const entries = fs.readdirSync(rootDir);
    return (
      entries.some((e) => e.endsWith(".xcodeproj")) ||
      entries.some((e) => e.endsWith(".xcworkspace")) ||
      entries.includes("Package.swift")
    );
  } catch {
    return false;
  }
}

/**
 * Returns true if rootDir appears to be a Godot project.
 * Detection: project.godot file present in the root.
 */
export function isGodotProject(rootDir) {
  try {
    return fs.existsSync(path.join(rootDir, "project.godot"));
  } catch {
    return false;
  }
}

/**
 * Returns true if rootDir appears to be a Unity project.
 * Detection: Assets/ + ProjectSettings/ directories both present,
 * OR a .sln file alongside an Assets/ directory.
 */
export function isUnityProject(rootDir) {
  try {
    const entries = fs.readdirSync(rootDir);
    const hasAssets = entries.includes("Assets");
    const hasProjectSettings = entries.includes("ProjectSettings");
    if (hasAssets && hasProjectSettings) return true;
    const hasSln = entries.some((e) => e.toLowerCase().endsWith(".sln"));
    return hasSln && hasAssets;
  } catch {
    return false;
  }
}

/**
 * Returns true if rootDir appears to be a SilverStripe project.
 * Detection: composer.json + vendor/silverstripe/framework OR a _config/ directory.
 */
export function isSilverStripeProject(rootDir) {
  try {
    if (!fs.existsSync(path.join(rootDir, "composer.json"))) return false;
    if (fs.existsSync(path.join(rootDir, "vendor", "silverstripe", "framework")))
      return true;
    if (fs.existsSync(path.join(rootDir, "_config"))) return true;
    // Check composer.json for silverstripe/framework dependency
    const composerRaw = fs.readFileSync(
      path.join(rootDir, "composer.json"),
      "utf8",
    );
    return composerRaw.includes('"silverstripe/');
  } catch {
    return false;
  }
}

/**
 * Detects the project type at rootDir and returns a structured context object:
 *   { isUnity, isCSharp, isPhp, isNode, isSilverStripe, projectType, constraints, researchDirective }
 *
 * All framework-specific content lives in projectDirectives.js — this file
 * contains only detection logic.
 *
 * This function is synchronous and cheap — it only reads the root directory
 * listing and a few known sentinel files.
 */
export function detectProjectContext(rootDir) {
  const isGodot = isGodotProject(rootDir);
  const unity = !isGodot && isUnityProject(rootDir);
  const isSwift = !unity && !isGodot && isSwiftProject(rootDir);

  let isCSharp = false;
  try {
    const entries = fs.readdirSync(rootDir);
    isCSharp = entries.some(
      (e) =>
        e.toLowerCase().endsWith(".sln") ||
        e.toLowerCase().endsWith(".csproj"),
    );
  } catch {
    /* ignore */
  }

  const isPhp = fs.existsSync(path.join(rootDir, "composer.json"));
  const isNode = fs.existsSync(path.join(rootDir, "package.json"));
  const isSilverStripe = !unity && isSilverStripeProject(rootDir);

  let projectType = "unknown";
  if (unity) projectType = "unity";
  else if (isSwift) projectType = "swift";
  else if (isGodot) projectType = "godot";
  else if (isCSharp) projectType = "csharp";
  else if (isSilverStripe) projectType = "silverstripe";
  else if (isPhp) projectType = "php";
  else if (isNode) projectType = "node";

  const constraints = buildConstraints({ unity, isSwift, isCSharp, isPhp, isNode, isSilverStripe, isGodot });
  const researchDirective = buildResearchDirective(projectType);

  return { isUnity: unity, isSwift, isCSharp, isPhp, isNode, isSilverStripe, isGodot, projectType, constraints, researchDirective };
}
