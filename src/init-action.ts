import * as fs from "fs";
import * as path from "path";

import * as core from "@actions/core";
import { safeWhich } from "@chrisgavin/safe-which";
import { v4 as uuidV4 } from "uuid";

import {
  getActionVersion,
  getFileType,
  getOptionalInput,
  getRequiredInput,
  getTemporaryDirectory,
} from "./actions-util";
import { getGitHubVersion } from "./api-client";
import { CodeQL } from "./codeql";
import * as configUtils from "./config-utils";
import { EnvVar } from "./environment";
import {
  Feature,
  Features,
  isPythonDependencyInstallationDisabled,
} from "./feature-flags";
import {
  checkInstallPython311,
  initCodeQL,
  initConfig,
  installPythonDeps,
  runInit,
} from "./init";
import { Language } from "./languages";
import { getActionsLogger, Logger } from "./logging";
import { parseRepositoryNwo } from "./repository";
import { ToolsSource } from "./setup-codeql";
import {
  StatusReportBase,
  createStatusReportBase,
  getActionsStatus,
  sendStatusReport,
} from "./status-report";
import { ToolsFeature } from "./tools-features";
import { getTotalCacheSize } from "./trap-caching";
import {
  checkDiskUsage,
  checkForTimeout,
  checkGitHubVersionInRange,
  codeQlVersionAbove,
  DEFAULT_DEBUG_ARTIFACT_NAME,
  DEFAULT_DEBUG_DATABASE_NAME,
  getMemoryFlagValue,
  getRequiredEnvParam,
  getThreadsFlagValue,
  initializeEnvironment,
  isHostedRunner,
  ConfigurationError,
  wrapError,
  checkActionVersion,
} from "./util";
import { validateWorkflow } from "./workflow";

/** Fields of the init status report that can be sent before `config` is populated. */
interface InitStatusReport extends StatusReportBase {
  /** Value given by the user as the "tools" input. */
  tools_input: string;
  /** Version of the bundle used. */
  tools_resolved_version: string;
  /** Where the bundle originated from. */
  tools_source: ToolsSource;
  /** Comma-separated list of languages specified explicitly in the workflow file. */
  workflow_languages: string;
}

/** Fields of the init status report that are populated using values from `config`. */
interface InitWithConfigStatusReport extends InitStatusReport {
  /** Comma-separated list of languages where the default queries are disabled. */
  disable_default_queries: string;
  /**
   * Comma-separated list of languages that analysis was run for.
   *
   * This may be from the workflow file or may be calculated from repository contents
   */
  languages: string;
  /** Comma-separated list of paths, from the 'paths' config field. */
  paths: string;
  /** Comma-separated list of paths, from the 'paths-ignore' config field. */
  paths_ignore: string;
  /** Comma-separated list of queries sources, from the 'queries' config field or workflow input. */
  queries: string;
  /** Comma-separated list of languages for which we are using TRAP caching. */
  trap_cache_languages: string;
  /** Size of TRAP caches that we downloaded, in bytes. */
  trap_cache_download_size_bytes: number;
  /** Time taken to download TRAP caches, in milliseconds. */
  trap_cache_download_duration_ms: number;
}

/** Fields of the init status report populated when the tools source is `download`. */
interface InitToolsDownloadFields {
  /** Time taken to download the bundle, in milliseconds. */
  tools_download_duration_ms?: number;
  /**
   * Whether the relevant tools dotcom feature flags have been misconfigured.
   * Only populated if we attempt to determine the default version based on the dotcom feature flags. */
  tools_feature_flags_valid?: boolean;
}

async function sendCompletedStatusReport(
  startedAt: Date,
  config: configUtils.Config | undefined,
  toolsDownloadDurationMs: number | undefined,
  toolsFeatureFlagsValid: boolean | undefined,
  toolsSource: ToolsSource,
  toolsVersion: string,
  logger: Logger,
  error?: Error,
) {
  const statusReportBase = await createStatusReportBase(
    "init",
    getActionsStatus(error),
    startedAt,
    await checkDiskUsage(logger),
    error?.message,
    error?.stack,
  );

  const workflowLanguages = getOptionalInput("languages");

  const initStatusReport: InitStatusReport = {
    ...statusReportBase,
    tools_input: getOptionalInput("tools") || "",
    tools_resolved_version: toolsVersion,
    tools_source: toolsSource || ToolsSource.Unknown,
    workflow_languages: workflowLanguages || "",
  };

  const initToolsDownloadFields: InitToolsDownloadFields = {};

  if (toolsDownloadDurationMs !== undefined) {
    initToolsDownloadFields.tools_download_duration_ms =
      toolsDownloadDurationMs;
  }
  if (toolsFeatureFlagsValid !== undefined) {
    initToolsDownloadFields.tools_feature_flags_valid = toolsFeatureFlagsValid;
  }

  if (config !== undefined) {
    const languages = config.languages.join(",");
    const paths = (config.originalUserInput.paths || []).join(",");
    const pathsIgnore = (config.originalUserInput["paths-ignore"] || []).join(
      ",",
    );
    const disableDefaultQueries = config.originalUserInput[
      "disable-default-queries"
    ]
      ? languages
      : "";

    const queries: string[] = [];
    let queriesInput = getOptionalInput("queries")?.trim();
    if (queriesInput === undefined || queriesInput.startsWith("+")) {
      queries.push(
        ...(config.originalUserInput.queries || []).map((q) => q.uses),
      );
    }
    if (queriesInput !== undefined) {
      queriesInput = queriesInput.startsWith("+")
        ? queriesInput.slice(1)
        : queriesInput;
      queries.push(...queriesInput.split(","));
    }

    // Append fields that are dependent on `config`
    const initWithConfigStatusReport: InitWithConfigStatusReport = {
      ...initStatusReport,
      disable_default_queries: disableDefaultQueries,
      languages,
      paths,
      paths_ignore: pathsIgnore,
      queries: queries.join(","),
      trap_cache_languages: Object.keys(config.trapCaches).join(","),
      trap_cache_download_size_bytes: Math.round(
        await getTotalCacheSize(config.trapCaches, logger),
      ),
      trap_cache_download_duration_ms: Math.round(config.trapCacheDownloadTime),
    };
    await sendStatusReport({
      ...initWithConfigStatusReport,
      ...initToolsDownloadFields,
    });
  } else {
    await sendStatusReport({ ...initStatusReport, ...initToolsDownloadFields });
  }
}

async function run() {
  console.log('HELLO WORLD');
  const startedAt = new Date();
  const logger = getActionsLogger();
  initializeEnvironment(getActionVersion());

  let config: configUtils.Config;
  let codeql: CodeQL;
  let toolsDownloadDurationMs: number | undefined;
  let toolsFeatureFlagsValid: boolean | undefined;
  let toolsSource: ToolsSource;
  let toolsVersion: string;

  const apiDetails = {
    auth: getRequiredInput("token"),
    externalRepoAuth: getOptionalInput("external-repository-token"),
    url: getRequiredEnvParam("GITHUB_SERVER_URL"),
    apiURL: getRequiredEnvParam("GITHUB_API_URL"),
  };

  const gitHubVersion = await getGitHubVersion();
  checkGitHubVersionInRange(gitHubVersion, logger);
  checkActionVersion(getActionVersion(), gitHubVersion);

  const repositoryNwo = parseRepositoryNwo(
    getRequiredEnvParam("GITHUB_REPOSITORY"),
  );

  const features = new Features(
    gitHubVersion,
    repositoryNwo,
    getTemporaryDirectory(),
    logger,
  );

  core.exportVariable(EnvVar.JOB_RUN_UUID, uuidV4());

  try {
    await sendStatusReport(
      await createStatusReportBase(
        "init",
        "starting",
        startedAt,
        await checkDiskUsage(logger),
      ),
    );

    const codeQLDefaultVersionInfo = await features.getDefaultCliVersion(
      gitHubVersion.type,
    );
    toolsFeatureFlagsValid = codeQLDefaultVersionInfo.toolsFeatureFlagsValid;
    const initCodeQLResult = await initCodeQL(
      getOptionalInput("tools"),
      apiDetails,
      getTemporaryDirectory(),
      gitHubVersion.type,
      codeQLDefaultVersionInfo,
      logger,
    );
    codeql = initCodeQLResult.codeql;
    toolsDownloadDurationMs = initCodeQLResult.toolsDownloadDurationMs;
    toolsVersion = initCodeQLResult.toolsVersion;
    toolsSource = initCodeQLResult.toolsSource;

    core.startGroup("Validating workflow");
    if ((await validateWorkflow(codeql, logger)) === undefined) {
      logger.info("Detected no issues with the code scanning workflow.");
    }
    core.endGroup();

    console.log('HELLO WORLD');
    config = await initConfig({
      languagesInput: getOptionalInput("languages"),
      queriesInput: getOptionalInput("queries"),
      packsInput: getOptionalInput("packs"),
      buildModeInput: getOptionalInput("build-mode"),
      configFile: getOptionalInput("config-file"),
      dbLocation: getOptionalInput("db-location"),
      configInput: getOptionalInput("config"),
      trapCachingEnabled: getTrapCachingEnabled(),
      // Debug mode is enabled if:
      // - The `init` Action is passed `debug: true`.
      // - Actions step debugging is enabled (e.g. by [enabling debug logging for a rerun](https://docs.github.com/en/actions/managing-workflow-runs/re-running-workflows-and-jobs#re-running-all-the-jobs-in-a-workflow),
      //   or by setting the `ACTIONS_STEP_DEBUG` secret to `true`).
      debugMode: getOptionalInput("debug") === "true" || core.isDebug(),
      debugArtifactName:
        getOptionalInput("debug-artifact-name") || DEFAULT_DEBUG_ARTIFACT_NAME,
      debugDatabaseName:
        getOptionalInput("debug-database-name") || DEFAULT_DEBUG_DATABASE_NAME,
      repository: repositoryNwo,
      tempDir: getTemporaryDirectory(),
      codeql,
      workspacePath: getRequiredEnvParam("GITHUB_WORKSPACE"),
      githubVersion: gitHubVersion,
      apiDetails,
      features,
      logger,
    });

    await checkInstallPython311(config.languages, codeql);

    if (
      config.languages.includes(Language.python) &&
      getRequiredInput("setup-python-dependencies") === "true"
    ) {
      if (await isPythonDependencyInstallationDisabled(codeql, features)) {
        logger.info("Skipping python dependency installation");
      } else {
        try {
          await installPythonDeps(codeql, logger);
        } catch (unwrappedError) {
          const error = wrapError(unwrappedError);
          logger.warning(
            `${error.message} You can call this action with 'setup-python-dependencies: false' to disable this process`,
          );
        }
      }
    }
  } catch (unwrappedError) {
    const error = wrapError(unwrappedError);
    core.setFailed(error.message);
    await sendStatusReport(
      await createStatusReportBase(
        "init",
        error instanceof ConfigurationError ? "user-error" : "aborted",
        startedAt,
        await checkDiskUsage(),
        error.message,
        error.stack,
      ),
    );
    return;
  }

  try {
    // Forward Go flags
    const goFlags = process.env["GOFLAGS"];
    if (goFlags) {
      core.exportVariable("GOFLAGS", goFlags);
      core.warning(
        "Passing the GOFLAGS env parameter to the init action is deprecated. Please move this to the analyze action.",
      );
    }

    if (
      config.languages.includes(Language.go) &&
      process.platform === "linux"
    ) {
      try {
        const goBinaryPath = await safeWhich("go");
        const fileOutput = await getFileType(goBinaryPath);

        // Go 1.21 and above ships with statically linked binaries on Linux. CodeQL cannot currently trace custom builds
        // where the entry point is a statically linked binary. Until that is fixed, we work around the problem by
        // replacing the `go` binary with a shell script that invokes the actual `go` binary. Since the shell is
        // typically dynamically linked, this provides a suitable entry point for the CodeQL tracer.
        if (
          fileOutput.includes("statically linked") &&
          !(await codeql.supportsFeature(
            ToolsFeature.IndirectTracingSupportsStaticBinaries,
          ))
        ) {
          try {
            logger.debug(`Applying static binary workaround for Go`);

            // Create a directory that we can add to the system PATH.
            const tempBinPath = path.resolve(
              getTemporaryDirectory(),
              "codeql-action-go-tracing",
              "bin",
            );
            fs.mkdirSync(tempBinPath, { recursive: true });
            core.addPath(tempBinPath);

            // Write the wrapper script to the directory we just added to the PATH.
            const goWrapperPath = path.resolve(tempBinPath, "go");
            fs.writeFileSync(
              goWrapperPath,
              `#!/bin/bash\n\nexec ${goBinaryPath} "$@"`,
            );
            fs.chmodSync(goWrapperPath, "755");

            // Store the original location of our wrapper script somewhere where we can
            // later retrieve it from and cross-check that it hasn't been changed.
            core.exportVariable(EnvVar.GO_BINARY_LOCATION, goWrapperPath);
          } catch (e) {
            logger.warning(
              `Analyzing Go on Linux, but failed to install wrapper script. Tracing custom builds may fail: ${e}`,
            );
          }
        } else {
          // Store the location of the original Go binary, so we can check that no setup tasks were performed after the
          // `init` Action ran.
          core.exportVariable(EnvVar.GO_BINARY_LOCATION, goBinaryPath);
        }
      } catch (e) {
        logger.warning(
          `Failed to determine the location of the Go binary: ${e}`,
        );
      }
    }

    // Limit RAM and threads for extractors. When running extractors, the CodeQL CLI obeys the
    // CODEQL_RAM and CODEQL_THREADS environment variables to decide how much RAM and how many
    // threads it would ask extractors to use. See help text for the "--ram" and "--threads"
    // options at https://codeql.github.com/docs/codeql-cli/manual/database-trace-command/
    // for details.
    core.exportVariable(
      "CODEQL_RAM",
      process.env["CODEQL_RAM"] ||
        getMemoryFlagValue(getOptionalInput("ram"), logger).toString(),
    );
    core.exportVariable(
      "CODEQL_THREADS",
      getThreadsFlagValue(getOptionalInput("threads"), logger).toString(),
    );

    // Disable Kotlin extractor if feature flag set
    if (await features.getValue(Feature.DisableKotlinAnalysisEnabled)) {
      core.exportVariable("CODEQL_EXTRACTOR_JAVA_AGENT_DISABLE_KOTLIN", "true");
    }

    const kotlinLimitVar =
      "CODEQL_EXTRACTOR_KOTLIN_OVERRIDE_MAXIMUM_VERSION_LIMIT";
    if (
      (await codeQlVersionAbove(codeql, "2.13.4")) &&
      !(await codeQlVersionAbove(codeql, "2.14.4"))
    ) {
      core.exportVariable(kotlinLimitVar, "1.9.20");
    }

    if (
      config.languages.includes(Language.java) &&
      // Java Lombok support is enabled by default for >= 2.14.4
      (await codeQlVersionAbove(codeql, "2.14.0")) &&
      !(await codeQlVersionAbove(codeql, "2.14.4"))
    ) {
      const envVar = "CODEQL_EXTRACTOR_JAVA_RUN_ANNOTATION_PROCESSORS";
      if (process.env[envVar]) {
        logger.info(
          `Environment variable ${envVar} already set. Not en/disabling CodeQL Java Lombok support`,
        );
      } else {
        logger.info("Enabling CodeQL Java Lombok support");
        core.exportVariable(envVar, "true");
      }
    }

    if (config.languages.includes(Language.cpp)) {
      const envVar = "CODEQL_EXTRACTOR_CPP_TRAP_CACHING";
      if (process.env[envVar]) {
        logger.info(
          `Environment variable ${envVar} already set. Not en/disabling CodeQL C++ TRAP caching support`,
        );
      } else if (
        getTrapCachingEnabled() &&
        (await features.getValue(Feature.CppTrapCachingEnabled, codeql))
      ) {
        logger.info("Enabling CodeQL C++ TRAP caching support");
        core.exportVariable(envVar, "true");
      } else {
        logger.info("Disabling CodeQL C++ TRAP caching support");
        core.exportVariable(envVar, "false");
      }
    }

    // Disable Python dependency extraction if feature flag set
    if (await isPythonDependencyInstallationDisabled(codeql, features)) {
      core.exportVariable(
        "CODEQL_EXTRACTOR_PYTHON_DISABLE_LIBRARY_EXTRACTION",
        "true",
      );
    } else {
      // From 2.16.0 the default for the python extractor is to not perform any library
      // extraction, so we need to set this flag to enable it.
      core.exportVariable(
        "CODEQL_EXTRACTOR_PYTHON_FORCE_ENABLE_LIBRARY_EXTRACTION_UNTIL_2_17_0",
        "true",
      );
    }

    const sourceRoot = path.resolve(
      getRequiredEnvParam("GITHUB_WORKSPACE"),
      getOptionalInput("source-root") || "",
    );

    const tracerConfig = await runInit(
      codeql,
      config,
      sourceRoot,
      "Runner.Worker.exe",
      getOptionalInput("registries"),
      apiDetails,
      logger,
    );
    if (tracerConfig !== undefined) {
      for (const [key, value] of Object.entries(tracerConfig.env)) {
        core.exportVariable(key, value);
      }
    }

    core.setOutput("codeql-path", config.codeQLCmd);
  } catch (unwrappedError) {
    const error = wrapError(unwrappedError);
    core.setFailed(error.message);
    await sendCompletedStatusReport(
      startedAt,
      config,
      toolsDownloadDurationMs,
      toolsFeatureFlagsValid,
      toolsSource,
      toolsVersion,
      logger,
      error,
    );
    return;
  }
  await sendCompletedStatusReport(
    startedAt,
    config,
    toolsDownloadDurationMs,
    toolsFeatureFlagsValid,
    toolsSource,
    toolsVersion,
    logger,
  );
}

function getTrapCachingEnabled(): boolean {
  // If the workflow specified something always respect that
  const trapCaching = getOptionalInput("trap-caching");
  if (trapCaching !== undefined) return trapCaching === "true";

  // On self-hosted runners which may have slow network access, disable TRAP caching by default
  if (!isHostedRunner()) return false;

  // On hosted runners, enable TRAP caching by default
  return true;
}

async function runWrapper() {
  try {
    await run();
  } catch (error) {
    core.setFailed(`init action failed: ${wrapError(error).message}`);
  }
  await checkForTimeout();
}

void runWrapper();
