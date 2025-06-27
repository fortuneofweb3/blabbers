const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Post = require('../models/post');
const ProcessedPost = require('../models/processedpost');
const Project = require('../models/project');
const User = require('../models/user');

const router = express.Router();

if (!process.env.X_BEARER_TOKEN) {
  throw new Error('[API] X_BEARER_TOKEN is not set');
}
console.log('[API] Twitter API Bearer Token configured');

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
    console.log('[API] Attempting Twitter API call for POST /users');
    const response = await axios.get(`https://api.twitter.com/2/users/by/username/${username}`, {
      headers: {
        Authorization: `Bearer ${process.env.X_BEARER_TOKEN}`,
        'Content-Type': 'application/json'
      },
      params: {
        'user.fields': 'id,name,username,profile_image_url,public_metrics'
      }
    });
    console.log('[API] Twitter API response:', response.data);
    const twitterUser = response.data.data;
    if (!twitterUser) {
      return res.status(404).json({ error: 'Twitter user not found' });
    }

    const userData = {
      SOL_ID,
      DEV_ID,
      userId: twitterUser.id,
      username: twitterUser.username,
      name: twitterUser.name || '',
      profile_image_url: twitterUser.profile_image_url || '',
      followers_count: twitterUser.public_metrics?.followers_count || 0,
      following_count: twitterUser.public_metrics?.following_count || 0,
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
    console.error('[API] POST /users error:', err.response?.status, err.message, err.stack);
    if (err.response?.status === 429) {
      return res.status(429).json({ 
        error: 'Twitter API rate limit exceeded', 
        details: 'Please try again after 15 minutes' 
      });
    }
    res.status(err.response?.status || 500).json({ error: 'Server error', details: err.message });
  }
});

router.get('/user-details/:username', async (req, res) => {
  try {
    console.log(`[API] Fetching user: ${req.params.username}`);
    const cachedUser = await User.findOne({ username: req.params.username }).lean();
    if (cachedUser) {
      console.log('[API] Found cached user data:', cachedUser);
      if (cachedUser.updatedAt > new Date(Date.now() - 15 * 60 * 1000)) {
        console.log('[API] Using fresh cached user data');
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
      console.log('[API] Cached user data stale, attempting Twitter API');
    } else {
      console.log('[API] No cached user data found');
    }

    console.log('[API] Attempting Twitter API call for GET /user-details');
    const response = await axios.get(`https://api.twitter.com/2/users/by/username/${req.params.username}`, {
      headers: {
        Authorization: `Bearer ${process.env.X_BEARER_TOKEN}`,
        'Content-Type': 'application/json'
      },
      params: {
        'user.fields': 'id,name,username,profile_image_url,public_metrics'
      }
    });
    console.log('[API] Twitter API response:', response.data);
    const twitterUser = response.data.data;
    if (!twitterUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = {
      userId: twitterUser.id,
      username: twitterUser.username,
      name: twitterUser.name || '',
      profile_image_url: twitterUser.profile_image_url || '',
      followers_count: twitterUser.public_metrics?.followers_count || 0,
      following_count: twitterUser.public_metrics?.following_count || 0,
      updatedAt: new Date()
    };
    const userDoc = await User.findOneAndUpdate(
      { userId: twitterUser.id },
      { $set: userData },
      { upsert: true, new: true }
    ).lean();
    console.log('[API] MongoDB userDoc updated:', userDoc);

    res.json({
      SOL_ID: userDoc.SOL_ID || '',
      DEV_ID: userDoc.DEV_ID || '',
      userId: twitterUser.id,
      username: twitterUser.username,
      name: twitterUser.name,
      profile_image_url: twitterUser.profile_image_url,
      followers_count: twitterUser.public_metrics.followers_count,
      following_count: twitterUser.public_metrics.following_count
    });
  } catch (err) {
    console.error('[API] GET /user-details error:', err.response?.status, err.message, err.stack);
    if (err.response?.status === 429 && cachedUser) {
      console.log('[API] Rate limit hit, falling back to stale cached user data');
      return res.json({
        SOL_ID: cachedUser.SOL_ID || '',
        DEV_ID: cachedUser.DEV_ID || '',
        userId: cachedUser.userId,
        username: cachedUser.username,
        name: cachedUser.name,
        profile_image_url: cachedUser.profile_image_url,
        followers_count: cachedUser.followers_count,
        following_count: cachedUser.following_count,
        warning: 'Using stale cached data due to Twitter API rate limit'
      });
    }
    if (err.response?.status === 429) {
      return res.status(429).json({ 
        error: 'Twitter API rate limit exceeded', 
        details: 'Please try again after 15 minutes' 
      });
    }
    res.status(err.response?.status || 500).json({ error: 'Server error', details: err.message });
  }
});

router.get('/rate-limit-status', async (req, res) => {
  try {
    console.log('[API] Checking Twitter API rate limit status');
    console.log('[API] Attempting Twitter API call for rate-limit-status');
    const response = await axios.get('https://api.twitter.com/2/users/by', {
      headers: {
        Authorization: `Bearer ${process.env.X_BEARER_TOKEN}`,
        'Content-Type': 'application/json'
      },
      params: {
        usernames: 'test',
        'user.fields': 'id'
      }
    });
    console.log('[API] Rate limit check response:', response.headers);
    res.json({ 
      message: 'Rate limit check', 
      rateLimit: {
        limit: response.headers['x-rate-limit-limit'],
        remaining: response.headers['x-rate-limit-remaining'],
        reset: new Date(parseInt(response.headers['x-rate-limit-reset']) * 1000)
      }
    });
  } catch (err) {
    console.error('[API] Rate limit check error:', err.response?.status, err.message, err.stack);
    res.status(err.response?.status || 500).json({ 
      error: 'Rate limit check failed', 
      details: err.message 
    });
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
    console.log('[API] Attempting Twitter API call for GET /posts');
    const userResponse = await axios.get(`https://api.twitter.com/2/users/by/username/${username}`, {
      headers: {
        Authorization: `Bearer ${process.env.X_BEARER_TOKEN}`,
        'Content-Type': 'application/json'
      },
      params: {
        'user.fields': 'id,public_metrics'
      }
    });
    console.log('[API] Twitter API user response:', userResponse.data);
    const twitterUser = userResponse.data.data;
    if (!twitterUser) {
      return res.status(404).json({ error: 'Twitter user not found' });
    }
    const userId = twitterUser.id;
    const followersCount = twitterUser.public_metrics?.followers_count || 0;

    const userData = {
      userId,
      username: twitterUser.username,
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

    console.log('[API] Attempting Twitter API call for user timeline');
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const tweetsResponse = await axios.get(`https://api.twitter.com/2/users/${userId}/tweets`, {
      headers: {
        Authorization: `Bearer ${process.env.X_BEARER_TOKEN}`,
        'Content-Type': 'application/json'
      },
      params: {
        'tweet.fields': 'created_at,public_metrics,text,referenced_tweets',
        exclude: 'retweets',
        max_results: 50,
        start_time: sevenDaysAgo
      }
    });
    console.log('[API] Twitter API tweets response:', tweetsResponse.data);
    const tweets = tweetsResponse.data.data || [];

    const categorizedPosts = {};
    dbProjects.forEach(project => {
      categorizedPosts[project.name.toUpperCase()] = [];
    });

    if (tweets.length) {
      for (const tweet of tweets) {
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
    console.error('[API] GET /posts error:', err.response?.status, err.message, err.stack);
    if (err.response?.status === 429) {
      return res.status(429).json({ 
        error: 'Twitter API rate limit exceeded', 
        details: 'Please try again after 15 minutes' 
      });
    }
    res.status(err.response?.status || 500).json({ error: 'Server error', details: err.message });
  }
});

module.exports = router;
