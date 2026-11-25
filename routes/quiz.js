const router = require('express').Router();
const { getCategories, startQuiz, scoreQuiz } = require('../services/quizService');
const { protect } = require('../middleware/auth');

router.get('/categories', protect, async (req, res) => {
  try {
    res.json({ success: true, categories: await getCategories() });
  } catch (e) {
    res.status(502).json({ success: false, message: e.message });
  }
});

router.post('/start', protect, async (req, res) => {
  try {
    const { category, difficulty } = req.body;
    const quiz = await startQuiz(req.user.id, { category, difficulty });
    res.json({ success: true, ...quiz });
  } catch (e) {
    res.status(502).json({ success: false, message: e.message });
  }
});

router.post('/submit', protect, (req, res) => {
  try {
    const { token, answers } = req.body;
    res.json({ success: true, ...scoreQuiz(req.user.id, token, answers) });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

module.exports = router;