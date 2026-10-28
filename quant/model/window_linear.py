"""Exact weighted ridge sufficient statistics in bounded row blocks.

Median imputation, unweighted StandardScaler and a fitted intercept match the
previous sklearn pipeline. No full imputed/scaled/weighted matrix is retained.
"""

from dataclasses import dataclass

import numpy as np
from sklearn.preprocessing import StandardScaler


@dataclass
class WindowRidge:
    fill: np.ndarray
    center: np.ndarray
    scale: np.ndarray
    coefficients: np.ndarray
    intercept: float

    def transformed(self, X):
        values = np.asarray(X, dtype=float)
        return (
            np.where(np.isnan(values), self.fill, values) - self.center
        ) / self.scale

    def predict(self, X):
        return self.transformed(X) @ self.coefficients + self.intercept

    @classmethod
    def fit(cls, X, y, weights, alpha, block_rows=2048):
        matrix = X.to_numpy(copy=False)
        fill = []
        for column in matrix.T:
            if np.isinf(column).any():
                raise ValueError("infinite ridge features")
            observed = column[~np.isnan(column)]
            fill.append(float(np.median(observed)) if len(observed) else 0.0)
        fill = np.asarray(fill)
        scaler = StandardScaler()
        for start in range(0, len(matrix), block_rows):
            block = matrix[start : start + block_rows]
            scaler.partial_fit(np.where(np.isnan(block), fill, block))
        state = cls(fill, scaler.mean_, scaler.scale_, np.zeros(matrix.shape[1]), 0.0)
        gram = np.zeros((matrix.shape[1], matrix.shape[1]))
        cross = np.zeros(matrix.shape[1])
        weighted_x = np.zeros(matrix.shape[1])
        weighted_y = 0.0
        total = float(weights.sum())
        if total <= 0 or alpha <= 0:
            raise ValueError("positive ridge weights and regularization are required")
        for start in range(0, len(matrix), block_rows):
            end = start + block_rows
            z = state.transformed(matrix[start:end])
            w, target = weights[start:end], y[start:end]
            wz = z * w[:, None]
            gram += z.T @ wz
            cross += wz.T @ target
            weighted_x += wz.sum(axis=0)
            weighted_y += float(w @ target)
        gram -= np.outer(weighted_x, weighted_x) / total
        cross -= weighted_x * (weighted_y / total)
        gram.flat[:: gram.shape[0] + 1] += alpha
        state.coefficients = np.linalg.solve(gram, cross)
        state.intercept = float(
            weighted_y / total - weighted_x @ state.coefficients / total
        )
        return state
