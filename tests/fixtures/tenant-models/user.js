module.exports = ({ DataTypes, definePrimaryType }) => {
  return {
    name: 'user',
    model: {
      tenantId: definePrimaryType('tenantId', {}),
      name: { type: DataTypes.STRING },
      avatar: { type: DataTypes.STRING },
      gender: { type: DataTypes.STRING },
      email: { type: DataTypes.STRING },
      phone: { type: DataTypes.STRING },
      description: { type: DataTypes.TEXT },
      status: { type: DataTypes.ENUM('enabled', 'disabled'), defaultValue: 'enabled' },
      roles: { type: DataTypes.JSONB, defaultValue: [] },
      tenantOrgIds: { type: DataTypes.JSONB, defaultValue: [] },
      synced: { type: DataTypes.BOOLEAN, defaultValue: false },
      syncSource: { type: DataTypes.STRING, allowNull: true },
      sourceId: { type: DataTypes.STRING, allowNull: true }
    }
  };
};
