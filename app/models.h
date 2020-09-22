#ifndef MODELS_H
#define MODELS_H

#include "models/blocks.h"
#include "models/functions.h"
#include "models/modules.h"

#include <QObject>
#include <QtSql/QSqlDatabase>

class Models : public QObject
{
    Q_OBJECT
    Q_DISABLE_COPY_MOVE(Models)
    Q_PROPERTY(Modules *modules READ modules NOTIFY modulesChanged)
    Q_PROPERTY(Functions *functions READ functions NOTIFY functionsChanged)
    Q_PROPERTY(Blocks *blocks READ blocks NOTIFY blocksChanged)

public:
    explicit Models(QObject *parent = 0);
    ~Models();

    static Models *instance();

    Q_INVOKABLE void open(QString name);
    Q_INVOKABLE void close();

    Modules *modules() const { return m_modules; }
    Functions *functions() const { return m_functions; }
    Blocks *blocks() const { return m_blocks; }

signals:
    void modulesChanged(Modules *newModules);
    void functionsChanged(Functions *newFunctions);
    void blocksChanged(Blocks *newBlocks);

private:
    static QString dbFilePath(QString name);

    QSqlDatabase m_db;
    Modules *m_modules;
    Functions *m_functions;
    Blocks *m_blocks;

    static Models *s_instance;
};

#endif // MODELS_H
