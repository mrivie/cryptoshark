var scheduler = new IOScheduler();
var modules = new Modules();
var functions = new Functions(modules, scheduler);

function open(process, callback) {
    var database = LocalStorage.openDatabaseSync(process.name, "1.0", "CryptoShark Database", 1000000);
    database.transaction(function (tx) {
        tx.executeSql("CREATE TABLE IF NOT EXISTS modules (" +
            "id INTEGER PRIMARY KEY, " +
            "name TEXT NOT NULL UNIQUE, " +
            "path TEXT NOT NULL UNIQUE, " +
            "base INTEGER NOT NULL, " +
            "main INTEGER NOT NULL, " +
            "calls INTEGER NOT NULL DEFAULT 0" +
        ")");
        tx.executeSql("CREATE INDEX IF NOT EXISTS modules_index ON modules(name, path);");

        tx.executeSql("CREATE TABLE IF NOT EXISTS functions (" +
            "id INTEGER PRIMARY KEY, " +
            "name TEXT NOT NULL UNIQUE, " +
            "module INTEGER, " +
            "offset INTEGER NOT NULL, " +
            "calls INTEGER NOT NULL DEFAULT 0, " +
            "FOREIGN KEY(module) REFERENCES modules(id)" +
        ")");

        modules.database = database;
        functions.database = database;

        callback();
    });
}

function close() {
    functions.database = null;
    modules.database = null;
}

function Modules() {
    var database = null;
    var cache = {};

    function AllWithCalls() {
        var items = [];
        var observers = [];

        var observable = {
            addObserver: function (observer) {
                observers.push(observer);
                observer.onModulesUpdate(items);
            },
            removeObserver: function (observer) {
                observers.splice(observers.indexOf(observer), 1);
            }
        };
        Object.defineProperty(observable, 'items', {get: function () { return items; }});
        Object.freeze(observable);

        this.observable = observable;

        this.load = function (database) {
            database.transaction(function (tx) {
                var rows = tx.executeSql("SELECT * FROM modules WHERE calls > 0 ORDER BY calls DESC").rows;
                items = Array.prototype.slice.call(rows);
                notifyObservers('onModulesUpdate', items);
            });
        };

        this.unload = function () {
            items = [];
            notifyObservers('onModulesUpdate', items);
        };

        function notifyObservers(event) {
            var args = Array.prototype.slice.call(arguments, 1);
            observers.forEach(function (observer) {
                if (observer[event]) {
                    observer[event].apply(observer, args);
                }
            });
        }

        Object.freeze(this);
    };

    var allWithCalls = new AllWithCalls();

    this.allWithCalls = function () {
        return allWithCalls.observable;
    };

    Object.defineProperty(this, 'database', {
        get: function () {
            return database;
        },
        set: function (value) {
            database = value;
            cache = {};
            if (database) {
                allWithCalls.load(database);
            } else {
                allWithCalls.unload();
            }
        }
    });

    this.update = function (update) {
        database.transaction(function (tx) {
            update.forEach(function (mod) {
                if (tx.executeSql("SELECT 1 FROM modules WHERE name = ?", [mod.name]).rows.length === 0) {
                    tx.executeSql("INSERT INTO modules (name, path, base, main) VALUES (?, ?, ?, ?)", [mod.name, mod.path, mod.base, mod.main ? 1 : 0]);
                } else {
                    tx.executeSql("UPDATE modules SET path = ?, base = ? WHERE name = ?", [mod.path, mod.base, mod.name]);
                }
            });
            cache = {};

            allWithCalls.load(database);
        });
    };

    this.incrementCalls = function (updates) {
        database.transaction(function (tx) {
            for (var id in updates) {
                if (updates.hasOwnProperty(id)) {
                    var calls = updates[id];
                    tx.executeSql("UPDATE modules SET calls = calls + ? WHERE id = ?", [calls, id]);
                }
            }
            cache = {};

            allWithCalls.load(database);
        });
    };

    this._getByName = function (name, transaction) {
        var module = cache[name];
        if (module) {
            return module;
        }
        module = transaction.executeSql("SELECT * FROM modules WHERE name = ?", [name]).rows[0];
        cache[name] = module;
        return module;
    };

    Object.freeze(this);
}

function Functions(modules, scheduler) {
    var database = null;
    var collections = {};

    function Collection(module) {
        var items = [];
        var functionByOffset = {};
        var dirty = {};
        var observers = [];

        var observable = {
            addObserver: function (observer) {
                observers.push(observer);
                observer.onFunctionsUpdate(items);
            },
            removeObserver: function (observer) {
                observers.splice(observers.indexOf(observer), 1);
            }
        };
        Object.defineProperty(observable, 'items', {get: function () { return items; }});
        Object.freeze(observable);

        this.observable = observable;

        this.load = function (database) {
            database.transaction(function (tx) {
                var rows = tx.executeSql("SELECT * FROM functions WHERE module = ? ORDER BY calls DESC", [module.id]).rows;
                items = Array.prototype.slice.call(rows);
                functionByOffset = items.reduce(function (functions, func) {
                    functions[func.offset] = func;
                    return functions;
                }, {});
                notifyObservers('onFunctionsUpdate', items);
            });
        };

        this.unload = function () {
            items = [];
            notifyObservers('onFunctionsUpdate', items);
        };

        this.update = function (updates) {
            var updated = [];

            updates.forEach(function (update) {
                var offset = update[0];
                var calls = update[1];

                var func = functionByOffset[offset];
                if (func) {
                    func.calls += calls;
                    updated.push(func);
                } else {
                    func = {
                        name: functionName(module, offset),
                        module: module.id,
                        offset: offset,
                        calls: calls
                    };
                    var index = sortedIndexOf(func);
                    items.splice(index, 0, func);
                    notifyObservers('onFunctionsAdd', index, func);
                    functionByOffset[offset] = func;
                }

                dirty[func.name] = func;
            });

            updated.forEach(function (func) {
                var oldIndex = items.indexOf(func);
                items.splice(oldIndex, 1);
                var newIndex = sortedIndexOf(func);
                if (newIndex !== oldIndex) {
                    items.splice(newIndex, 0, func);
                    notifyObservers('onFunctionsMove', oldIndex, newIndex);
                    notifyObservers('onFunctionsUpdate', items, [newIndex, 'calls', func.calls]);
                } else {
                    items.splice(oldIndex, 0, func);
                    notifyObservers('onFunctionsUpdate', items, [oldIndex, 'calls', func.calls]);
                }
            });

            scheduler.schedule(flush);
        };

        function functionName(module, offset) {
            return functionPrefix(module) + "_" + offset.toString(16);
        }

        function functionPrefix(module) {
            if (module.main) {
                return "sub";
            } else {
                return module.name.replace(/^lib/, "").replace(/[-_]/g, "").replace(/\.\w+$/, "").toLocaleLowerCase();
            }
        }

        function flush(quotaExceeded) {
            var finished = true;
            do {
                database.transaction(function (tx) {
                    var finishedNames = [];
                    for (var name in dirty) {
                        if (dirty.hasOwnProperty(name)) {
                            var func = dirty[name];
                            if (func.id) {
                                tx.executeSql("UPDATE functions SET calls = ? WHERE id = ?", [func.calls, func.id]);
                            } else {
                                var result = tx.executeSql("INSERT INTO functions (name, module, offset, calls) VALUES (?, ?, ?, ?)", [name, module.id, func.offset, func.calls]);
                                func.id = result.insertId;
                            }
                            finishedNames.push(name);
                            if (finishedNames.length === 10) {
                                finished = false;
                                break;
                            }
                        }
                    }
                    finishedNames.forEach(function (name) {
                        delete dirty[name];
                    });
                });
            }
            while (!finished && !quotaExceeded());
            return finished;
        }

        function sortedIndexOf(func) {
            for (var i = 0; i !== items.length; i++) {
                if (func.calls > items[i].calls) {
                    return i;
                }
            }
            return items.length;
        }

        function notifyObservers(event) {
            var args = Array.prototype.slice.call(arguments, 1);
            observers.forEach(function (observer) {
                if (observer[event]) {
                    observer[event].apply(observer, args);
                }
            });
        }

        Object.freeze(this);
    };

    function getCollection(module) {
        var collection = collections[module.id];
        if (!collection) {
            collection = new Collection(module);
            if (database) {
                collection.load(database);
            }
            collections[module.id] = collection;
        }
        return collection;
    }

    this.allInModule = function (module) {
        return getCollection(module).observable;
    };

    Object.defineProperty(this, 'database', {
        get: function () {
            return database;
        },
        set: function (value) {
            database = value;

            for (var moduleId in collections) {
                if (collections.hasOwnProperty(moduleId)) {
                    if (database) {
                        collections[moduleId].load(database);
                    } else {
                        collections[moduleId].unload();
                    }
                }
            }
        }
    });

    this.update = function (update) {
        database.transaction(function (tx) {
            var updates;

            var summary = update.summary;
            var collectionUpdates = {};
            var moduleCalls = {};
            for (var address in summary) {
                if (summary.hasOwnProperty(address)) {
                    var entry = summary[address];
                    var symbol = entry.symbol;
                    if (symbol) {
                        var module = modules._getByName(symbol.module, tx);
                        updates = collectionUpdates[module.id];
                        if (!updates) {
                            updates = [getCollection(module)];
                            collectionUpdates[module.id] = updates;
                        }
                        updates.push([symbol.offset, entry.count]);
                        moduleCalls[module.id] = (moduleCalls[module.id] || 0) + entry.count;
                    } else {
                        // TODO
                    }
                }
            }

            for (var moduleId in collectionUpdates) {
                if (collectionUpdates.hasOwnProperty(moduleId)) {
                    updates = collectionUpdates[moduleId];
                    var collection = updates[0];
                    collection.update(updates.slice(1));
                }
            }

            modules.incrementCalls(moduleCalls);
        });
    };

    Object.freeze(this);
};

function IOScheduler() {
    var timer = null;
    var pending = [];

    this.configure = function (t) {
        timer = t;
        timer.interval = 15;
        timer.repeat = true;
    };

    this.tick = function () {
        var started = new Date();

        function quotaExceeded() {
            var now = new Date();
            var elapsed = now - started;
            return elapsed >= 10;
        }

        while (pending.length > 0) {
            var work = pending[0];
            var finished = work(quotaExceeded);
            if (finished) {
                pending.splice(0, 1);
            } else {
                break;
            }
        }

        if (pending.length === 0) {
            timer.stop();
        }
    };

    this.schedule = function (work) {
        pending.push(work);
        timer.start();
    };
}
