import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homeSections } from './homeSections.js'

test('worklist with items becomes the hero and hides the duplicates', () => {
  const s = homeSections({
    worklistCount: 5,
    unansweredCount: 3,
    followupsTodayCount: 2,
    overdueCount: 4,
    hotLeadsCount: 2,
    activityCount: 6,
  })
  assert.equal(s.worklist, true)
  assert.equal(s.unanswered, false)
  assert.equal(s.followupsToday, false)
  assert.equal(s.overdue, false)
  // Non-duplicates still show.
  assert.equal(s.hotLeads, true)
  assert.equal(s.activity, true)
})

test('empty worklist falls back to the individual lists', () => {
  const s = homeSections({
    worklistCount: 0,
    unansweredCount: 3,
    followupsTodayCount: 2,
    overdueCount: 4,
  })
  assert.equal(s.worklist, false)
  assert.equal(s.unanswered, true)
  assert.equal(s.followupsToday, true)
  assert.equal(s.overdue, true)
})

test('fallback lists still respect their own counts', () => {
  const s = homeSections({ worklistCount: 0, unansweredCount: 0, followupsTodayCount: 1, overdueCount: 0 })
  assert.equal(s.unanswered, false)
  assert.equal(s.followupsToday, true)
  assert.equal(s.overdue, false)
})

test('site visits / hot leads / activity are independent of the worklist', () => {
  const withWork = homeSections({ worklistCount: 9, siteVisitsCount: 2, hotLeadsCount: 1, activityCount: 3 })
  assert.equal(withWork.siteVisits, true)
  assert.equal(withWork.hotLeads, true)
  assert.equal(withWork.activity, true)

  const noWork = homeSections({ worklistCount: 0, siteVisitsCount: 0, hotLeadsCount: 0, activityCount: 0 })
  assert.equal(noWork.siteVisits, false)
  assert.equal(noWork.hotLeads, false)
  assert.equal(noWork.activity, false)
})

test('no args is safe (all hidden)', () => {
  const s = homeSections()
  assert.deepEqual(s, {
    worklist: false,
    unanswered: false,
    followupsToday: false,
    overdue: false,
    siteVisits: false,
    hotLeads: false,
    activity: false,
  })
})
