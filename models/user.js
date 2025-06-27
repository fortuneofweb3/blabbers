const mongoose = require('mongoose');
const UserSchema = new mongoose.Schema({
  SOL_ID: { type: String, required: true, unique: true, index: true },
  DEV_ID: { type: String, required: true, unique: true },
  userId: { type: String, required: true },
  username: { type: String, required: true, unique: true, index: true },
  name: String,
  profile_image_url: String,
  followers_count: Number,
  following_count: Number,
  bio: String,
  location: String,
  created_at: Date
});
module.exports = mongoose.model('User', UserSchema);
