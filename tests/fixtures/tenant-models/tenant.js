module.exports = ({ DataTypes }) => {
  return {
    name: 'tenant',
    model: {
      name: { type: DataTypes.STRING },
      status: { type: DataTypes.ENUM('open', 'closed'), defaultValue: 'open' },
      description: { type: DataTypes.TEXT },
      logo: { type: DataTypes.STRING },
      themeColor: { type: DataTypes.STRING },
      source: { type: DataTypes.STRING, allowNull: true },
      sourceId: { type: DataTypes.STRING, allowNull: true }
    }
  };
};
