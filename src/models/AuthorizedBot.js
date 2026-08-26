const mongoose = require('mongoose');

const authorizedBotSchema = new mongoose.Schema({
  botUsername: { type: String, required: true, unique: true, index: true },
  apiUrl:      { type: String, required: true },
  isActive:    { type: Boolean, default: true },
  addedBy:     { type: Number, default: null },
  createdAt:   { type: Date, default: Date.now },
});

module.exports = mongoose.model('AuthorizedBot', authorizedBotSchema);
