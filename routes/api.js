const express = require('express');
const cors = require('cors');
const router = express.Router();
const { TwitterApi } = require('twitter-api-v2');
const Post = require('../models/post');
const ProcessedPost = require('../models/processedpost');
const Project = require('../models/project');
const User = require('../models/user');

if (!process.env.X_BEARER_TOKEN) {
  throw new Error('[API] X_BEARER_TOKEN is not set');
}
const client = new TwitterApi(process.env.X_BEARER_TOKEN);

router.use(cors());

function isValidSolanaAddress(address) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

function isValidDevId(devId) {
  return /^[a-zA-Z0-9_-]{8,64}$/.test(devId);
}

function extractHashtags(text) {
  const hashtags = [];
  const regex = /#(\w+)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    hashtags.push(match[1]);
  }
  return hashtags;
}

function extractMentions(text) {
  const regex = /@(\w+)/g;
  let mentionChars = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    mentionChars += match[0].length;
  }
  return mentionChars;
}

function calculateQualityScore(tweet, followersCount) {
  const lengthScore = Math.min(Math.max((tweet.text.length - 50) / 200, 0), 1);
  const { like_count, retweet_count, quote_count } = tweet.public_metrics || {};
  const engagementRaw = like_count + 2 * retweet_count + 3 * quote_count;
  const engagementScore = Math.min(engagementRaw / Math.max(1, followersCount), 1);
  const combinedScore = 0.5 * 0.5 + 0.25 * lengthScore + 0.25 * engagementScore;
  return Math.round(combinedScore * 99) + 1;
}

function calculateBlabzPerProject(qualityScore) {
  return (qualityScore / 300).toFixed(4);
}

router.post('/users', async (req, res) => {
  try {
    const { username, SOL_ID, DEV_ID } = req.body;
    if (!username || !SOL_ID || !DEV_ID) {
      return res.status(400).json({ error: 'username, SOL_ID, and DEV_ID required' });
    }
    if (!isValidSolanaAddress(SOL_ID)) {
      return res.status(400).json({ error: 'Invalid SOL_ID' });
    }
    if (!isValidDevId(DEV_ID)) {
      return res.status(400).json({ error: 'Invalid DEV_ID' });
    }

    const existingUser = await User.findOne({
      $or: [{ SOL_ID, username: { $ne: username } }, { DEV_ID, username: { $ne: username } }]
    });
    if (existingUser) {
      return res.status(400).json({ error: 'SOL_ID or DEV_ID already used' });
    }

    console.log(`[API] Fetching Twitter user: ${username}`);
    const twitterUser = await client.v2.userByUsername(username, {
      'user.fields': ['id', 'name', 'username', 'profile_image_url', 'public_metrics']
    });
    console.log('[API] Twitter API response:', twitterUser.data);
    if (!twitterUser.data) {
      return res.status(404).json({ error: 'Twitter user not found' });
    }

    const userData = {
      SOL_ID,
      DEV_ID,
      userId: twitterUser.data.id,
      username: twitterUser.data.username,
      name: twitterUser.data.name || '',
      profile_image_url: twitterUser.data.profile_image_url || '',
      followers_count: twitterUser.data.public_metrics?.followers_count || 0,
      following_count: twitterUser.data.public_metrics?.following_count || 0,
      updatedAt: new Date()
    };

    const user = await User.findOneAndUpdate(
      { username },
      { $set: userData },
      { upsert: true, new: true }
    );
    console.log(`[MongoDB] User ${username} saved:`, user);
    res.json({ message: `User ${username} saved`, user });
  } catch (err) {
    console.error('[API] POST /users error:', err.message, err.stack);
    if (err.code === 429) {
      return res.status(429).json({ 
        error: 'Twitter API rate limit exceeded', 
        details: 'Please try again after 15 minutes' 
      });
    }
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

router.get('/user-details/:username', async (req, res) => {
  try {
    console.log(`[API] Fetching user: ${req.params.username}`);
    const cachedUser = await User.findOne({ username: req.params.username }).lean();
    if (cachedUser && cachedUser.updatedAt > new Date(Date.now() - 15 * 60 * 1000)) {
      console.log('[API] Using cached user data:', cachedUser);
      return res.json({
        SOL_ID: cachedUser.SOL_ID || '',
        DEV_ID: cachedUser.DEV_ID || '',
        userId: cachedUser.userId,
        username: cachedUser.username,
        name: cachedUser.name,
        profile_image_url: cachedUser.profile_image_url,
        followers_count: cachedUser.followers_count,
        following_count: cachedUser.following_count
      });
    }

    const twitterUser = await client.v2.userByUsername(req.params.username, {
      'user.fields': ['id', 'name', 'username', 'profile_image_url', 'public_metrics']
    });
    console.log('[API] Twitter API response:', twitterUser.data);
    if (!twitterUser.data) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = {
      userId: twitterUser.data.id,
      username: twitterUser.data.username,
      name: twitterUser.data.name || '',
      profile_image_url: twitterUser.data.profile_image_url || '',
      followers_count: twitterUser.data.public_metrics?.followers_count || 0,
      following_count: twitterUser.data.public_metrics?.following_count || 0,
      updatedAt: new Date()
    };
    const userDoc = await User.findOneAndUpdate(
      { userId: twitterUser.data.id },
      { $set: userData },
      { upsert: true, new: true }
    ).lean();
    console.log('[API] MongoDB userDoc:', userDoc);

    res.json({
      SOL_ID: userDoc.SOL_ID || '',
      DEV_ID: userDoc.DEV_ID || '',
      userId: twitterUser.data.id,
      username: twitterUser.data.username,
      name: twitterUser.data.name,
      profile_image_url: twitterUser.data.profile_image_url,
      followers_count: twitterUser.data.public_metrics.followers_count,
      following_count: twitterUser.data.public_metrics.following_count
    });
  } catch (err) {
    console.error('[API] GET /user-details error:', err.message, err.stack);
    if (err.code === 429) {
      return res.status(429).json({ 
        error: 'Twitter API rate limit exceeded', 
        details: 'Please try again after 15 minutes' 
      });
    }
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

router.post('/projects', async (req, res) => {
  try {
    const { name, keywords, description } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Name required' });
    }
    const projectData = {
      name: name.toUpperCase(),
      keywords: keywords || [],
      description: description || '',
      updatedAt: new Date()
    };
    const project = await Project.findOneAndUpdate(
      { name: name.toUpperCase() },
      { $set: projectData },
      { upsert: true, new: true }
    );
    console.log(`[MongoDB] Project ${name} saved:`, project);
    res.json({ message: `Project ${name} added`, project });
  } catch (err) {
    console.error('[API] POST /projects error:', err.message, err.stack);
    res.status(400).json({ error: 'Server error', details: err.message });
  }
});

router.put('/project/:project', async (req, res) => {
  try {
    const projectData = {
      ...req.body,
      name: req.params.project.toUpperCase(),
      updatedAt: new Date()
    };
    const project = await Project.findOneAndUpdate(
      { name: req.params.project.toUpperCase() },
      { $set: projectData },
      { new: true }
    );
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    console.log(`[MongoDB] Project ${req.params.project} updated:`, project);
    res.json({ message: `Project ${req.params.project} updated`, project });
  } catch (err) {
    console.error('[API] PUT /project error:', err.message, err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

router.get('/posts/:username', async (req, res) => {
  try {
    const { username } = req.params;

    const userDoc = await User.findOne({ username }).lean();
    if (!userDoc) {
      return res.status(404).json({ error: 'User not found in database' });
    }

    console.log(`[API] Fetching timeline for user: ${username}`);
    const twitterUser = await client.v2.userByUsername(username, { 'user.fields': ['id', 'public_metrics'] });
    console.log('[API] Twitter API user response:', twitterUser.data);
    if (!twitterUser.data) {
      return res.status(404).json({ error: 'Twitter user not found' });
    }
    const userId = twitterUser.data.id;
    const followersCount = twitterUser.data.public_metrics?.followers_count || 0;

    // Update user in MongoDB
    const userData = {
      userId,
      username: twitterUser.data.username,
      followers_count: followersCount,
      updatedAt: new Date()
    };
    await User.findOneAndUpdate(
      { userId },
      { $set: userData },
      { upsert: true }
    );
    console.log(`[MongoDB] User ${username} updated`);

    const dbProjects = await Project.find().lean();
    if (!dbProjects.length) {
      return res.status(404).json({ error: 'No projects configured' });
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const tweets = await client.v2.userTimeline(userId.toString(), {
      'tweet.fields': ['created_at', 'public_metrics', 'text', 'referenced_tweets'],
      exclude: ['retweets'],
      max_results: 50,
      start_time: sevenDaysAgo
    });

    const categorizedPosts = {};
    dbProjects.forEach(project => {
      categorizedPosts[project.name.toUpperCase()] = [];
    });

    if (tweets.meta.result_count) {
      for await (const tweet of tweets) {
        if (tweet.text.length < 51) {
          await ProcessedPost.findOneAndUpdate({ postId: tweet.id }, { postId: tweet.id, updatedAt: new Date() }, { upsert: true });
          continue;
        }

        if (extractMentions(tweet.text) / tweet.text.length > 0.6) {
          await ProcessedPost.findOneAndUpdate({ postId: tweet.id }, { postId: tweet.id, updatedAt: new Date() }, { upsert: true });
          continue;
        }

        if (tweet.referenced_tweets?.[0]?.type === 'replied_to') {
          await ProcessedPost.findOneAndUpdate({ postId: tweet.id }, { postId: tweet.id, updatedAt: new Date() }, { upsert: true });
          continue;
        }

        if (await ProcessedPost.findOne({ postId: tweet.id }).lean()) {
          continue;
        }

        const text = tweet.text.toLowerCase();
        const matchedProjects = dbProjects
          .filter(project => {
            const terms = [project.name.toLowerCase(), ...project.keywords.map(k => k.toLowerCase())];
            return terms.some(term => text.includes(term));
          })
          .map(project => project.name.toUpperCase());

        if (matchedProjects.length === 0) {
          await ProcessedPost.findOneAndUpdate({ postId: tweet.id }, { postId: tweet.id, updatedAt: new Date() }, { upsert: true });
          continue;
        }

        const qualityScore = calculateQualityScore(tweet, followersCount);
        const projectBlabz = parseFloat(calculateBlabzPerProject(qualityScore));
        const totalBlabz = (projectBlabz * matchedProjects.length).toFixed(4);

        const postData = {
          SOL_ID: userDoc.SOL_ID || userId,
          DEV_ID: userDoc.DEV_ID || '',
          userId,
          username,
          postId: tweet.id,
          content: tweet.text,
          project: matchedProjects,
          score: qualityScore,
          blabz: totalBlabz,
          likes: tweet.public_metrics.like_count,
          retweets: tweet.public_metrics.retweet_count,
          replies: tweet.public_metrics.reply_count,
          hashtags: extractHashtags(tweet.text),
          tweetUrl: `https://x.com/${username}/status/${tweet.id}`,
          createdAt: tweet.created_at,
          tweetType: 'main',
          updatedAt: new Date()
        };

        const post = await Post.findOneAndUpdate(
          { postId: tweet.id },
          { $set: postData },
          { upsert: true, new: true }
        );
        await ProcessedPost.findOneAndUpdate({ postId: tweet.id }, { postId: tweet.id, updatedAt: new Date() }, { upsert: true });
        console.log(`[MongoDB] Post ${tweet.id} saved for user ${username}`);

        matchedProjects.forEach(project => {
          categorizedPosts[project].push(postData);
        });
      }
    }

    const dbPosts = await Post.find({ userId, createdAt: { $gte: new Date(sevenDaysAgo) } }).lean();
    dbPosts.forEach(post => {
      const postData = {
        SOL_ID: post.SOL_ID || userId,
        DEV_ID: post.DEV_ID || '',
        userId: post.userId,
        username: post.username,
        postId: post.postId,
        content: post.content,
        project: post.project,
        score: post.score,
        blabz: post.blabz,
        likes: post.likes,
        retweets: post.retweets,
        replies: post.replies,
        hashtags: post.hashtags || [],
        tweetUrl: post.tweetUrl,
        createdAt: post.createdAt,
        tweetType: post.tweetType
      };
      post.project.forEach(project => {
        if (categorizedPosts[project]) {
          categorizedPosts[project].push(postData);
        }
      });
    });

    for (const project in categorizedPosts) {
      const seenPostIds = new Set();
      categorizedPosts[project] = categorizedPosts[project].filter(post => {
        if (seenPostIds.has(post.postId)) return false;
        seenPostIds.add(post.postId);
        return true;
      });
      categorizedPosts[project].sort((a, b) => b.score - a.score);
    }

    const totalPosts = Object.values(categorizedPosts).reduce((sum, posts) => sum + posts.length, 0);
    const response = {
      message: totalPosts ? 'Posts retrieved' : 'No relevant posts found',
      posts: categorizedPosts
    };

    res.json(response);
  } catch (err) {
    console.error('[API] GET /posts error:', err.message, err.stack);
    if (err.code === 429) {
      return res.status(429).json({ 
        error: 'Twitter API rate limit exceeded', 
        details: 'Please try again after 15 minutes' 
      });
    }
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

module.exports = router;
