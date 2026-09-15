module.exports = ({ DataTypes, definePrimaryType }) => {
  return {
    name: 'role',
    model: {
      tenantId: definePrimaryType('tenantId', {}),
      name: { type: DataTypes.STRING },
      code: { type: DataTypes.STRING },
      type: { type: DataTypes.ENUM('system', 'custom'), defaultValue: 'custom' },
      status: { type: DataTypes.ENUM('open', 'closed'), defaultValue: 'open' },
      description: { type: DataTypes.TEXT },
      permissions: { type: DataTypes.JSONB, defaultValue: [] },
      source: { type: DataTypes.STRING, allowNull: true },
      sourceId: { type: DataTypes.STRING, allowNull: true }
    }
  };
};
