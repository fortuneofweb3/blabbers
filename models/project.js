const mongoose = require('mongoose');

const projectSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  keywords: { type: [String], default: [] },
  description: { type: String, default: '' },
  twitterUsername: { type: String, default: '' },
  userId: { type: String, default: '' },
  profile_image_url: { type: String, default: '' },
  name: { type: String, default: '' },
  followers_count: { type: Number, default: 0 },
  following_count: { type: Number, default: 0 },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Project', projectSchema);
