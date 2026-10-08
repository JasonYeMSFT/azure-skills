const fs = require("fs").promises;
const path = require("path");

const MARKETPLACE_NAME = "azure-skills";
const PLUGINS_DIRECTORY = path.join(".github", "plugins");

const cliConfigurations = {
  copilot: {
    enumerateArguments: [
      "plugin",
      "marketplace",
      "browse",
      MARKETPLACE_NAME,
      "--json",
    ],
    selectMarketplacePlugins(result) {
      if (
        !Array.isArray(result) ||
        result.length === 0 ||
        result.some(plugin => plugin.marketplace !== MARKETPLACE_NAME)
      ) {
        throw new Error(
          "Copilot did not enumerate a valid, non-empty azure-skills marketplace.",
        );
      }
      return result;
    },
    installedArguments: ["plugin", "list", "--json"],
    isInstalled(installedPlugins, pluginName) {
      return installedPlugins.some(
        plugin => plugin.name === pluginName && plugin.enabled === true,
      );
    },
  },
  claude: {
    enumerateArguments: ["plugin", "list", "--available", "--json"],
    selectMarketplacePlugins(result) {
      if (!Array.isArray(result.available)) {
        throw new Error("Claude Code did not return an available plugin list.");
      }

      const marketplacePlugins = result.available.filter(
        plugin => plugin.marketplaceName === MARKETPLACE_NAME,
      );
      if (marketplacePlugins.length === 0) {
        throw new Error(
          "Claude Code did not enumerate any azure-skills marketplace plugins.",
        );
      }
      return marketplacePlugins;
    },
    installedArguments: ["plugin", "list", "--json"],
    isInstalled(installedPlugins, pluginName) {
      const pluginId = `${pluginName}@${MARKETPLACE_NAME}`;
      return installedPlugins.some(
        plugin => plugin.id === pluginId && plugin.enabled === true,
      );
    },
  },
};

async function runJson(exec, command, args) {
  const result = await exec.getExecOutput(command, args, {
    silent: true,
    ignoreReturnCode: true,
  });
  if (result.exitCode !== 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(
      `${command} ${args.join(" ")} exited with code ${result.exitCode}`,
    );
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `Invalid JSON from ${command} ${args.join(" ")}: ${error.message}`,
    );
  }
}

async function getRepositoryPlugins() {
  const entries = await fs.readdir(PLUGINS_DIRECTORY, { withFileTypes: true });
  const directories = entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  if (directories.length === 0) {
    throw new Error(`No plugin directories were found under ${PLUGINS_DIRECTORY}.`);
  }

  const plugins = [];
  for (const directory of directories) {
    const manifestPath = path.join(
      PLUGINS_DIRECTORY,
      directory,
      ".plugin",
      "plugin.json",
    );
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    } catch (error) {
      throw new Error(`Cannot read plugin manifest ${manifestPath}: ${error.message}`);
    }
    if (
      typeof manifest.name !== "string" ||
      manifest.name.trim().length === 0
    ) {
      throw new Error(`Plugin manifest ${manifestPath} has no valid name.`);
    }
    plugins.push({ directory, name: manifest.name });
  }

  const seenNames = new Set();
  const duplicateNames = new Set();
  for (const plugin of plugins) {
    if (seenNames.has(plugin.name)) {
      duplicateNames.add(plugin.name);
    }
    seenNames.add(plugin.name);
  }
  if (duplicateNames.size > 0) {
    throw new Error(
      `Multiple repository plugins declare the same name: ${[...duplicateNames].join(", ")}`,
    );
  }

  return plugins;
}

module.exports = async function testPluginInstallation({ cli, exec, core }) {
  const configuration = cliConfigurations[cli];
  if (!configuration) {
    throw new Error(`Unsupported plugin CLI: ${cli}`);
  }

  const enumerationResult = await runJson(
    exec,
    cli,
    configuration.enumerateArguments,
  );
  const marketplacePlugins =
    configuration.selectMarketplacePlugins(enumerationResult);
  core.info(JSON.stringify(marketplacePlugins, null, 2));

  const repositoryPlugins = await getRepositoryPlugins();
  const marketplaceNames = new Set(
    marketplacePlugins.map(plugin => plugin.name),
  );
  for (const plugin of repositoryPlugins) {
    if (!marketplaceNames.has(plugin.name)) {
      throw new Error(
        `Repository plugin ${plugin.directory} (${plugin.name}) is missing from the ${MARKETPLACE_NAME} marketplace.`,
      );
    }
  }

  for (const plugin of repositoryPlugins) {
    await exec.exec(cli, [
      "plugin",
      "install",
      `${plugin.name}@${MARKETPLACE_NAME}`,
    ]);
  }

  const installedPlugins = await runJson(
    exec,
    cli,
    configuration.installedArguments,
  );
  if (!Array.isArray(installedPlugins)) {
    throw new Error(`${cli} did not return an installed plugin list.`);
  }
  core.info(JSON.stringify(installedPlugins, null, 2));

  for (const plugin of repositoryPlugins) {
    if (!configuration.isInstalled(installedPlugins, plugin.name)) {
      throw new Error(
        `Plugin ${plugin.name}@${MARKETPLACE_NAME} is not installed and enabled.`,
      );
    }
  }
};
