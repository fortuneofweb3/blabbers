const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const processedPostSchema = new Schema({
  postId: { type: String, required: true, unique: true },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ProcessedPost', processedPostSchema);
