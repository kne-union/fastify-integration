// 我托管的下游清单（部署级）。
// 与 host 表是两个独立方向，同一部署可同时非空：既被别人托管，又托管别人。
module.exports = ({ DataTypes }) => {
  return {
    model: {
      appCode: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '下游应用编码，同时作为其权限树在本系统的顶层模块 code'
      },
      name: {
        type: DataTypes.STRING,
        comment: '下游应用名称'
      },
      apiUrl: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '下游 integration 接口基地址'
      },
      appId: {
        type: DataTypes.STRING,
        comment: '我调用下游时使用的 appId（下游签发）'
      },
      secretKey: {
        type: DataTypes.STRING,
        comment: '我调用下游时使用的 secretKey（下游签发）'
      },
      callbackAppId: {
        type: DataTypes.STRING,
        comment: '我签发给下游、供其回拉我时使用的 appId，用于反查 appCode'
      },
      status: {
        type: DataTypes.ENUM('enabled', 'disabled'),
        defaultValue: 'enabled',
        comment: '状态:启用，停用'
      },
      installedAt: {
        type: DataTypes.DATE,
        comment: '最近一次 install 成功时间'
      },
      manifestCache: {
        type: DataTypes.JSONB,
        comment: 'manifest 缓存，仅用于拉取失败时降级，非权威数据'
      },
      manifestCachedAt: {
        type: DataTypes.DATE,
        comment: 'manifest 缓存时间'
      },
      options: {
        type: DataTypes.JSONB,
        comment: '扩展字段',
        defaultValue: {}
      }
    },
    options: {
      comment: '集成下游应用注册表',
      indexes: [
        {
          fields: ['app_code'],
          unique: true,
          where: {
            deleted_at: null
          }
        },
        {
          fields: ['callback_app_id']
        }
      ]
    }
  };
};
