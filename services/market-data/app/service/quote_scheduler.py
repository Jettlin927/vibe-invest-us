from collections import deque
import threading

class _Batch:
    def __init__(self, jobs):
        self.jobs = deque(enumerate(jobs))
        self.results = [None] * len(jobs)
        self.remaining = len(jobs)
        self.error = None
        self.done = threading.Event()


class _FairBatchScheduler:
    def __init__(self, workers: int):
        self._condition = threading.Condition()
        self._batches = deque()
        for index in range(workers):
            threading.Thread(
                target=self._worker, name=f"quote-batch-{index}", daemon=True,
            ).start()

    def run(self, jobs):
        if not jobs:
            return []
        batch = _Batch(jobs)
        with self._condition:
            self._batches.append(batch)
            self._condition.notify_all()
        batch.done.wait()
        if batch.error is not None:
            raise batch.error
        return batch.results

    def _worker(self):
        while True:
            with self._condition:
                while not self._batches:
                    self._condition.wait()
                batch = self._batches.popleft()
                result_index, job = batch.jobs.popleft()
                if batch.jobs:
                    self._batches.append(batch)
            try:
                result, error = job(), None
            except BaseException as cause:
                result, error = None, cause
            with self._condition:
                batch.results[result_index] = result
                batch.remaining -= 1
                if error is not None and batch.error is None:
                    batch.error = error
                if batch.remaining == 0:
                    batch.done.set()
