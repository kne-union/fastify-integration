module.exports = ({ DataTypes, definePrimaryType }) => {
  return {
    name: 'setting',
    model: {
      tenantId: definePrimaryType('tenantId', {}),
      permissions: { type: DataTypes.JSONB, defaultValue: [] }
    }
  };
};
