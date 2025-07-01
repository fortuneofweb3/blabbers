const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const projectSchema = new Schema({
  name: { type: String, required: true, unique: true },
  displayName: { type: String, default: '' },
  keywords: { type: [String], default: [] },
  description: { type: String, default: '' },
  website: { type: String, default: '' },
  twitterUsername: { type: String, default: '' },
  userId: { type: String, default: '' },
  profile_image_url: { type: String, default: '' },
  followers_count: { type: Number, default: 0 },
  following_count: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Project', projectSchema);
