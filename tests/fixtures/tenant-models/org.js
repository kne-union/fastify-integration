module.exports = ({ DataTypes, definePrimaryType }) => {
  return {
    name: 'org',
    model: {
      tenantId: definePrimaryType('tenantId', {}),
      name: { type: DataTypes.STRING },
      description: { type: DataTypes.TEXT },
      index: { type: DataTypes.INTEGER, defaultValue: 0 },
      parentId: definePrimaryType('parentId', { allowNull: true }),
      leaderUserId: definePrimaryType('leaderUserId', { allowNull: true }),
      status: { type: DataTypes.ENUM('open', 'closed'), defaultValue: 'open' },
      synced: { type: DataTypes.BOOLEAN, defaultValue: false },
      syncSource: { type: DataTypes.STRING, allowNull: true },
      sourceId: { type: DataTypes.STRING, allowNull: true }
    }
  };
};
