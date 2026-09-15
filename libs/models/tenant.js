// 租户开通关系：本系统的某个租户开通了哪个下游应用。
// 这是开通状态的唯一权威，租户权限上限（ceiling）不承担这个职责，它只表达"开通了哪些模块"。
module.exports = ({ DataTypes, options }) => {
  return {
    model: {
      appCode: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '下游应用编码'
      },
      remoteTenantId: {
        type: DataTypes.STRING,
        comment: '该租户在下游对应的影子租户ID'
      },
      status: {
        type: DataTypes.ENUM('enabled', 'disabled'),
        defaultValue: 'enabled',
        comment: '状态:启用，停用'
      },
      linkedAt: {
        type: DataTypes.DATE,
        comment: '开通时间'
      },
      lastSnapshotAt: {
        type: DataTypes.DATE,
        comment: '最近一次快照投影成功时间'
      },
      lastSnapshotError: {
        type: DataTypes.TEXT,
        comment: '最近一次快照投影失败原因'
      },
      options: {
        type: DataTypes.JSONB,
        comment: '扩展字段',
        defaultValue: {}
      }
    },
    associate: ({ tenant: tenantLink }, fastify) => {
      // associate 在 fastify.sequelize.sync() 时才执行，此时 fastify[tenantName] 已就绪
      tenantLink.belongsTo(fastify[options.tenantName].models.tenant, {
        foreignKey: 'tenantId',
        allowNull: false
      });
    },
    options: {
      comment: '集成租户开通关系',
      indexes: [
        {
          fields: ['tenant_id', 'app_code'],
          unique: true,
          where: {
            deleted_at: null
          }
        },
        {
          fields: ['app_code']
        }
      ]
    }
  };
};
