const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const userSchema = new Schema({
  SOL_ID: { type: String, required: false },
  DEV_ID: { type: String, required: false },
  userId: { type: String, required: true, unique: true },
  username: { type: String, required: true, unique: true },
  name: { type: String, default: '' },
  profile_image_url: { type: String, default: '' },
  followers_count: { type: Number, default: 0 },
  following_count: { type: Number, default: 0 },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);
