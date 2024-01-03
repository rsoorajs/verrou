import knex, { type Knex } from 'knex'

import { E_RELEASE_NOT_OWNED } from '../errors.js'
import type { DatabaseStoreOptions, Duration, LockStore } from '../types/main.js'

/**
 * Create a new database store
 */
export function databaseStore(config: DatabaseStoreOptions) {
  return { config, factory: () => new DatabaseStore(config) }
}

export class DatabaseStore implements LockStore {
  /**
   * Knex connection instance
   */
  #connection: Knex

  /**
   * The name of the table used to store locks
   */
  #tableName = 'verrou'

  /**
   * A promise that resolves when the table is created
   */
  #initialized: Promise<void>

  constructor(config: DatabaseStoreOptions) {
    this.#connection = this.#createConnection(config)
    this.#tableName = config.tableName || this.#tableName
    this.#initialized = this.#createTableIfNotExists()
  }

  /**
   * Create a Knex connection instance
   */
  #createConnection(config: DatabaseStoreOptions) {
    if (typeof config.connection === 'string') {
      return knex({ client: config.dialect, connection: config.connection, useNullAsDefault: true })
    }

    /**
     * This looks hacky. Maybe we can find a better way to do this?
     * We check if config.connection is a Knex object. If it is, we
     * return it as is. If it's not, we create a new Knex object
     */
    if ('with' in config.connection!) {
      return config.connection
    }

    return knex({ client: config.dialect, connection: config.connection, useNullAsDefault: true })
  }

  /**
   * Create the cache table if it doesn't exist
   */
  async #createTableIfNotExists() {
    const hasTable = await this.#connection.schema.hasTable(this.#tableName)
    if (hasTable) return

    await this.#connection.schema.createTable(this.#tableName, (table) => {
      table.string('key', 255).notNullable().primary()
      table.string('owner').notNullable()
      table.bigint('expiration').unsigned().nullable()
    })
  }

  /**
   * Compute the expiration date based on the provided TTL
   */
  #computeExpiresAt(ttl: number | null) {
    if (ttl) return Date.now() + ttl
    return null
  }

  /**
   * Get the current owner of given lock key
   */
  async #getCurrentOwner(key: string) {
    await this.#initialized
    const result = await this.#connection
      .table(this.#tableName)
      .where('key', key)
      .select('owner')
      .first()

    return result?.owner
  }

  extend(_key: string, _duration: Duration): Promise<void> {
    throw new Error('Method not implemented.')
  }

  /**
   * Save a new lock
   *
   * We basically rely on primary key constraint to ensure the lock is
   * unique.
   *
   * If the lock already exists, we check if it's expired. If it is, we
   * update it with the new owner and expiration date.
   */
  async save(key: string, owner: string, ttl: number | null) {
    try {
      await this.#initialized
      await this.#connection
        .table(this.#tableName)
        .insert({ key, owner, expiration: this.#computeExpiresAt(ttl) })

      return true
    } catch (error) {
      const updated = await this.#connection
        .table(this.#tableName)
        .where('key', key)
        .where('expiration', '<=', Date.now())
        .update({ owner, expiration: this.#computeExpiresAt(ttl) })

      return updated >= 1
    }
  }

  /**
   * Delete a lock
   */
  async delete(key: string, owner: string): Promise<void> {
    const currentOwner = await this.#getCurrentOwner(key)
    if (currentOwner !== owner) throw new E_RELEASE_NOT_OWNED()

    await this.#connection.table(this.#tableName).where('key', key).where('owner', owner).delete()
  }

  /**
   * Check if a lock exists
   */
  async exists(key: string) {
    await this.#initialized
    const result = await this.#connection
      .table(this.#tableName)
      .where('key', key)
      .select('expiration')
      .first()

    if (!result) return false
    if (result.expiration === null) return true

    return result.expiration > Date.now()
  }

  /**
   * Disconnect knex connection
   */
  disconnect() {
    return this.#connection.destroy()
  }
}
