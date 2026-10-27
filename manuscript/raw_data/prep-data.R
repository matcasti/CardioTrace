
# Prepare workspace -------------------------------------------------------

## Load libraries
library(data.table)
library(ggplot2)

cardiotrace <- (readLines("manuscript/raw_data/cardiotrace.txt", warn = FALSE) |> as.numeric())[-c(1:13)][1:983]
elitehrv <- readLines("manuscript/raw_data/elitehrv.txt", warn = FALSE) |> as.numeric()

data <- data.table(cardiotrace = cardiotrace, elitehrv = elitehrv, time = cumsum(elitehrv)/60000)

r_squared <- 1-sum((elitehrv-cardiotrace)^2)/sum((elitehrv-mean(elitehrv))^2)
rmse <- sqrt(mean((elitehrv-cardiotrace)^2))
mape <- mean(abs((elitehrv-cardiotrace)/elitehrv)) * 100

## Agreement statistics reported in the text (Bland-Altman style)
d <- cardiotrace - elitehrv
bias <- mean(d)
loa <- bias + c(-1, 1) * 1.96 * sd(d)
cat(sprintf("n = %d beats | duration = %.1f min | mean RR = %.1f ms\n", length(d), sum(elitehrv)/60000, mean(elitehrv)))
cat(sprintf("R2 = %.4f | RMSE = %.2f ms | MAPE = %.2f %%\n", r_squared, rmse, mape))
cat(sprintf("bias = %.2f ms | 95%% LoA = [%.2f, %.2f] ms | max |diff| = %.1f ms\n", bias, loa[1], loa[2], max(abs(d))))

fig1a <- ggplot(data, aes(time)) +
  geom_line(aes(y = elitehrv, col = "EliteHRV"), linewidth = 2, alpha = 0.5) +
  geom_line(aes(y = cardiotrace, col = "CardioTrace")) +
  scale_color_manual(values = c(EliteHRV = "gray", CardioTrace = "darkred")) +
  theme_classic() +
  labs(color = "Application", x = "Time (minutes)", y = "R-R interval (ms)") +
  theme(legend.position = "top") +
  annotate(geom = "text", label = paste0("RMSE = ", round(rmse,3), " ms"), y = 850, x = 2.5, hjust = 0) +
  annotate(geom = "text", label = paste0("MAPE = ", round(mape,3), "%"), y = 850-15, x = 2.5, hjust = 0)

fig1b <- ggplot(data, aes(elitehrv, cardiotrace, col = "Data point")) +
  geom_abline(slope = 1, intercept = 0, alpha = 0.5, linewidth = 1) +
  geom_point() +
  scale_color_manual(values = c("Data point" = "darkred")) +
  theme_classic() +
  labs(color = "Symbol", x = "EliteHRV R-R interval (ms)", y = "CardioTrace R-R interval (ms)") +
  theme(legend.position = "top") +
  annotate(geom = "text", label = paste0("R squared = ", round(r_squared,4)), y = 800, x = 600, hjust = 0)

fig1 <- cowplot::plot_grid(fig1a, fig1b, ncol = 2, axis = "lb", align = "hv")

ggsave("manuscript/figure-3.png", fig1, device = "png", scale = 6, units = "px",
       height = 400, width = 600, dpi = 400)
