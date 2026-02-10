const fs = require("fs/promises");

const { ensureParentDirectory } = require("./utils");

const DEFAULT_STATE = {
  version: 1,
  managedByTitle: {},
};

class StateStore {
  constructor(statePath) {
    this.statePath = statePath;
    this.state = structuredClone(DEFAULT_STATE);
  }

  async load() {
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw);
      this.state = {
        ...structuredClone(DEFAULT_STATE),
        ...(parsed || {}),
        managedByTitle: { ...(parsed?.managedByTitle || {}) },
      };
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }

      await this.save();
    }

    return this.state;
  }

  getState() {
    return this.state;
  }

  getManagedRecord(title) {
    return this.state.managedByTitle[title] || null;
  }

  getManagedTitles() {
    return Object.keys(this.state.managedByTitle);
  }

  upsertManagedTarget({
    title,
    targetId,
    gameId,
    amount,
    priceUsd,
    metadata = {},
  }) {
    const current = this.state.managedByTitle[title] || {};
    const now = new Date().toISOString();

    this.state.managedByTitle[title] = {
      ...current,
      title,
      targetId,
      gameId,
      amount,
      priceUsd,
      updatedAt: now,
      createdAt: current.createdAt || now,
      metadata: {
        ...(current.metadata || {}),
        ...(metadata || {}),
      },
    };
  }

  removeManagedTargetByTitle(title) {
    delete this.state.managedByTitle[title];
  }

  pruneMissingTargets(activeTargets) {
    const activeTitles = new Set(activeTargets.map((target) => target.Title));
    const removed = [];

    for (const title of this.getManagedTitles()) {
      if (!activeTitles.has(title)) {
        removed.push(title);
        delete this.state.managedByTitle[title];
      }
    }

    return removed;
  }

  async save() {
    await ensureParentDirectory(this.statePath);

    const serialized = `${JSON.stringify(this.state, null, 2)}\n`;
    const tempFile = `${this.statePath}.tmp`;

    await fs.writeFile(tempFile, serialized, "utf8");
    await fs.rename(tempFile, this.statePath);
  }
}

module.exports = {
  StateStore,
};
