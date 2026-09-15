class IntegrationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'IntegrationError';
    this.code = status;
    this.status = status;
    this.codeMessage = code;
    this.message = message;
  }

  toJSON() {
    return {
      code: this.codeMessage,
      message: this.message,
      status: this.status
    };
  }
}

module.exports = { IntegrationError };
