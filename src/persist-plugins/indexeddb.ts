import { isPrimitive, isPromise, observable, setAtPath, when } from '@legendapp/state';
import type {
    Change,
    Observable,
    ObservablePersistenceConfig,
    ObservablePersistLocal,
    PersistMetadata,
    PersistOptionsLocal,
} from '../observableInterfaces';

function requestToPromise(request: IDBRequest) {
    return new Promise<void>((resolve) => (request.onsuccess = () => resolve()));
}

export class ObservablePersistIndexedDB implements ObservablePersistLocal {
    private tableData: Record<string, any> = {};
    private tableMetadata: Record<string, any> = {};
    private tablesAdjusted: Map<string, Observable<boolean>> = new Map();
    private db: IDBDatabase;

    public initialize(config: ObservablePersistenceConfig['persistLocalOptions']) {
        if (typeof indexedDB === 'undefined') return;
        if (process.env.NODE_ENV === 'development' && !config) {
            console.error('[legend-state] Must configure ObservablePersistIndexedDB');
        }

        const { databaseName, version, tableNames } = config.indexedDB;
        const openRequest = indexedDB.open(databaseName, version);

        openRequest.onerror = () => {
            console.error('Error', openRequest.error);
        };

        openRequest.onupgradeneeded = () => {
            const db = openRequest.result;
            const { tableNames } = config.indexedDB;
            // Create a table for each name with "id" as the key
            tableNames.forEach((table) => {
                db.createObjectStore(table, {
                    keyPath: 'id',
                });
            });
        };

        return new Promise<void>((resolve) => {
            openRequest.onsuccess = async () => {
                this.db = openRequest.result;

                const preload =
                    typeof window !== 'undefined' &&
                    ((window as any).__legend_state_preload as {
                        tableData: any;
                        tableMetadata: any;
                        dataPromise: Promise<any>;
                    });

                let didPreload = false;
                if (preload) {
                    // Load from preload or wait for it to finish, if it exists
                    if (!preload.tableData && preload.dataPromise) {
                        await preload.dataPromise;
                    }
                    this.tableData = preload.tableData;
                    this.tableMetadata = preload.tableMetadata;
                    didPreload = !!preload.tableData;
                }
                if (!didPreload) {
                    // Load each table
                    const tables = tableNames.filter((table) => this.db.objectStoreNames.contains(table));
                    try {
                        const transaction = this.db.transaction(tables, 'readonly');

                        await Promise.all(tables.map((table) => this.initTable(table, transaction)));
                    } catch (err) {
                        console.error('[legend-state] Error loading IndexedDB', err);
                    }
                }

                resolve();
            };
        });
    }
    public loadTable(table: string, config: PersistOptionsLocal): void | Promise<void> {
        if (!this.tableData[table]) {
            const transaction = this.db.transaction(table, 'readonly');

            return this.initTable(table, transaction).then(() => this.loadTable(table, config));
        }

        const prefix = config.indexedDB?.prefixID;

        if (prefix) {
            const tableName = prefix ? table + '/' + prefix : table;
            if (this.tablesAdjusted.has(tableName)) {
                const promise = when(this.tablesAdjusted.get(tableName));
                if (isPromise(promise)) {
                    return promise as unknown as Promise<void>;
                }
            } else {
                const obsLoaded = observable(false);
                this.tablesAdjusted.set(tableName, obsLoaded);
                const data = this.getTable(table, config);
                let hasPromise = false;
                let promises: Promise<any>[];
                if (data) {
                    const keys = Object.keys(data);
                    promises = keys.map((key) => {
                        const value = data[key];

                        if (isPromise(value)) {
                            hasPromise = true;
                            return value.then(() => {
                                data[key] = value;
                            });
                        } else {
                            data[key] = value;
                        }
                    });
                }
                if (hasPromise) {
                    return Promise.all(promises).then(() => {
                        obsLoaded.set(true);
                    });
                } else {
                    obsLoaded.set(true);
                }
            }
        }
    }
    public getTable(table: string, config: PersistOptionsLocal) {
        const configIDB = config.indexedDB;
        const prefix = configIDB?.prefixID;
        const data = this.tableData[prefix ? table + '/' + prefix : table];
        if (data && configIDB?.itemID) {
            return data[configIDB.itemID];
        } else {
            return data;
        }
    }
    public getTableTransformed<T = any>(table: string, config: PersistOptionsLocal<any>): T {
        const configIDB = config.indexedDB;
        const prefix = configIDB?.prefixID;
        const data = this.tableData[(prefix ? table + '/' + prefix : table) + '_transformed'];
        if (data && configIDB?.itemID) {
            return data[configIDB.itemID];
        } else {
            return data;
        }
    }
    public getMetadata(table: string, config: PersistOptionsLocal) {
        const { tableName } = this.getMetadataTableName(table, config);
        return this.tableMetadata[tableName];
    }
    public async updateMetadata(table: string, metadata: PersistMetadata, config: PersistOptionsLocal): Promise<void> {
        const { tableName, tableNameBase } = this.getMetadataTableName(table, config);
        // Assign new metadata into the table, and make sure it has the id
        metadata = Object.assign(this.tableMetadata[tableName] || {}, metadata, {
            id: tableNameBase + '__legend_metadata',
        });
        this.tableMetadata[tableName] = metadata;
        const store = this.transactionStore(table);
        store.put(metadata);
    }
    public async set(table: string, changes: Change[], config: PersistOptionsLocal) {
        if (typeof indexedDB === 'undefined') return;

        const store = this.transactionStore(table);

        const prefixID = config.indexedDB?.prefixID;
        if (prefixID) {
            table += '/' + prefixID;
        }
        const prev = this.tableData[table];

        const itemID = config.indexedDB?.itemID;

        // Combine changes into a minimal set of saves
        const savesItems: Record<string, any> = {};
        let saveTable: any;
        for (let i = 0; i < changes.length; i++) {
            // eslint-disable-next-line prefer-const
            let { path, valueAtPath, pathTypes } = changes[i];
            if (itemID) {
                path = [itemID].concat(path as string[]);
                pathTypes.splice(0, 0, 'object');
            }
            if (path.length > 0) {
                // If change is deep in an object save it to IDB by the first key
                const key = path[0] as string;
                if (!this.tableData[table]) {
                    this.tableData[table] = {};
                }
                setAtPath(this.tableData[table], path as string[], pathTypes, valueAtPath);
                savesItems[key] = this.tableData[table][key];
            } else {
                // Set the whole table
                saveTable = valueAtPath;
                break;
            }
        }

        const puts = await Promise.all(
            saveTable
                ? [this._setTable(table, prev, saveTable, store, config)]
                : Object.keys(savesItems).map((key) => this._setItem(table, key, savesItems[key], store, config))
        );

        const lastPut = puts[puts.length - 1];
        return requestToPromise(lastPut);
    }
    public async deleteTable(table: string, config: PersistOptionsLocal): Promise<void> {
        const configIDB = config.indexedDB;
        const prefixID = configIDB?.prefixID;
        const tableName = prefixID ? table + '/' + prefixID : table;
        let data = this.tableData[tableName];
        const itemID = configIDB?.itemID;
        if (data && configIDB?.itemID) {
            data = data[itemID];
            delete data[itemID];
        } else {
            delete this.tableData[tableName];
            delete this.tableData[tableName + '_transformed'];
        }

        if (typeof indexedDB === 'undefined') return;

        if (data) {
            const store = this.transactionStore(table);
            let result: Promise<any>;
            if (!prefixID && !itemID) {
                result = requestToPromise(store.clear());
            } else {
                const keys = Object.keys(data);
                result = Promise.all(
                    keys.map((key) => {
                        if (prefixID) {
                            key = prefixID + '/' + key;
                        }
                        return requestToPromise(store.delete(key));
                    })
                );
            }
            // Clear the table from IDB
            return result;
        }
    }
    // Private
    private getMetadataTableName(table: string, config: PersistOptionsLocal) {
        const configIDB = config.indexedDB;
        let name = '';
        if (configIDB) {
            const { prefixID, itemID } = configIDB;

            if (itemID) {
                name = itemID;
            }
            if (prefixID) {
                name = prefixID + (name ? '/' + name : '');
            }
        }

        return { tableNameBase: name, tableName: name ? table + '/' + name : table };
    }
    private initTable(table: string, transaction: IDBTransaction): Promise<void> {
        // If changing this, change it in the preloader too
        const store = transaction.objectStore(table);
        const allRequest = store.getAll();

        if (!this.tableData[table]) {
            this.tableData[table] = {};
        }
        return new Promise((resolve) => {
            allRequest.onsuccess = () => {
                const arr = allRequest.result;
                let metadata: PersistMetadata;
                if (!this.tableData[table]) {
                    this.tableData[table] = {};
                }
                for (let i = 0; i < arr.length; i++) {
                    const val = arr[i];

                    // In case id is a number convert it to a string
                    if (!val.id.includes) {
                        val.id = val.id + '';
                    }

                    if (val.id.endsWith('__legend_metadata')) {
                        const id = val.id.replace('__legend_metadata', '');
                        // Save this as metadata
                        delete val.id;
                        metadata = val;
                        const tableName = id ? table + '/' + id : table;
                        this.tableMetadata[tableName] = metadata;
                    } else {
                        let tableName = table;

                        if (val.id.includes('/')) {
                            const [prefix, id] = val.id.split('/');
                            tableName += '/' + prefix;
                            val.id = id;
                        }

                        if (!this.tableData[tableName]) {
                            this.tableData[tableName] = {};
                        }
                        this.tableData[tableName][val.id] = val;
                    }
                }
                resolve();
            };
        });
    }
    private transactionStore(table: string) {
        const transaction = this.db.transaction(table, 'readwrite');
        return transaction.objectStore(table);
    }
    private async _setItem(table: string, key: string, value: any, store: IDBObjectStore, config: PersistOptionsLocal) {
        if (!value) {
            if (this.tableData[table]) {
                delete this.tableData[table][key];
            }
            return store.delete(key);
        } else {
            if (isPrimitive(value)) return;

            if (value.id === undefined) {
                // If value does not have its own ID, assign it the key from the Record
                value.id = key;
            }

            if (config) {
                if (!this.tableData[table]) {
                    this.tableData[table] = {};
                }
                this.tableData[table][key] = value;

                const didClone = false;

                const prefixID = config.indexedDB?.prefixID;
                if (prefixID) {
                    if (didClone) {
                        value.id = prefixID + '/' + value.id;
                    } else {
                        value = Object.assign({}, value, {
                            id: prefixID + '/' + value.id,
                        });
                    }
                }
            }

            return store.put(value);
        }
    }
    private async _setTable(
        table: string,
        prev: object,
        value: object,
        store: IDBObjectStore,
        config: PersistOptionsLocal
    ) {
        const keys = Object.keys(value);
        let lastSet: IDBRequest;
        // Do a set for each key in the object
        const sets = await Promise.all(
            keys.map((key) => {
                const val = value[key];
                return this._setItem(table, key, val, store, config);
            })
        );
        lastSet = sets[sets.length - 1];

        // Delete keys that are no longer in the object
        if (prev) {
            const keysOld = Object.keys(prev);
            const deletes = (
                await Promise.all(
                    keysOld.map((key) => {
                        if (value[key] === undefined) {
                            return this._setItem(table, key, null, store, config);
                        }
                    })
                )
            ).filter((a) => !!a);
            if (deletes.length > 0) {
                lastSet = deletes[deletes.length - 1];
            }
        }
        return lastSet;
    }
}
