const mongoose = require('mongoose');
const ProcessedPostSchema = new mongoose.Schema({
  postId: { type: String, required: true, unique: true, index: true }
});
module.exports = mongoose.model('ProcessedPost', ProcessedPostSchema);