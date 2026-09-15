// 托管我的上游清单（部署级）。
// 一个部署可以同时被多个上游托管，每个上游各持一对独立凭据。
module.exports = ({ DataTypes }) => {
  return {
    model: {
      hostAppCode: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '上游应用编码，同时作为影子租户的 source 值'
      },
      name: {
        type: DataTypes.STRING,
        comment: '上游应用名称'
      },
      apiUrl: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '上游 integration 接口基地址，用于回拉快照'
      },
      callbackAppId: {
        type: DataTypes.STRING,
        comment: '我回拉上游时使用的 appId（上游 install 时下发）'
      },
      callbackSecretKey: {
        type: DataTypes.STRING,
        comment: '我回拉上游时使用的 secretKey（上游 install 时下发）'
      },
      inboundAppId: {
        type: DataTypes.STRING,
        comment: '上游调用我时使用的 appId，用于从入站签名反查是哪个上游'
      },
      status: {
        type: DataTypes.ENUM('enabled', 'disabled'),
        defaultValue: 'enabled',
        comment: '状态:启用，停用'
      },
      installedAt: {
        type: DataTypes.DATE,
        comment: '最近一次被 install 的时间'
      },
      options: {
        type: DataTypes.JSONB,
        comment: '扩展字段',
        defaultValue: {}
      }
    },
    options: {
      comment: '集成上游应用注册表',
      indexes: [
        {
          fields: ['host_app_code'],
          unique: true,
          where: {
            deleted_at: null
          }
        },
        {
          fields: ['inbound_app_id']
        }
      ]
    }
  };
};
